import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { readdirSync, statSync } from "node:fs";
import { err, ok, Result, ResultAsync } from "neverthrow";
import {
  validateRepositoryUrl,
  type RuntimeEvent,
  type RuntimeHealth,
  type ServerFrame,
} from "@pi-orb/protocol";
import type { HarnessSnapshot, LiveOperationView } from "../domain/types.ts";
import type { AgentGateView } from "../domain/requests.ts";
import { LiveHistoryPublisher } from "./live-history.ts";
import { mapPiEntry, mapPiSessionHeader } from "./mapping.ts";

export interface PiOrbAgentOptions {
  readonly orbId: string;
  readonly repositoryUrl: string;
  /** Persistent orb filesystem root (the Docker volume). */
  readonly workDir: string;
  /** Directory containing the shared auth.json (DESIGN.md §15.1). */
  readonly authDir: string;
}

export interface SnapshotError {
  readonly type: "snapshot_error";
  readonly message: string;
}

type FrameListener = (frame: ServerFrame) => void;

interface LiveBlock {
  blockType: "text" | "reasoning";
  revision: number;
  text: string;
}

interface LiveTool {
  name: string;
  revision: number;
  state: "running" | "completed" | "failed";
  message?: string;
}

const execGit = (args: string[], cwd: string): ResultAsync<string, { message: string }> =>
  ResultAsync.fromPromise(
    new Promise<string>((resolve, reject) => {
      execFile(
        "git",
        args,
        {
          cwd,
          timeout: 10 * 60_000,
          env: {
            ...process.env,
            GIT_ALLOW_PROTOCOL: "https",
            GIT_TERMINAL_PROMPT: "0",
          },
        },
        (error, stdout, stderr) => {
          if (error !== null) reject(new Error(stderr || error.message));
          else resolve(stdout.trim());
        },
      );
    }),
    (error) => ({ message: error instanceof Error ? error.message : String(error) }),
  );

/**
 * The Pi SDK integration: owns the session, translates Pi events to protocol
 * frames, and exposes synchronous snapshots for pulls and the hello sync
 * batch. One instance per runtime process.
 */
export class PiOrbAgent {
  readonly runtimeInstanceId = randomUUID();
  private readonly options: PiOrbAgentOptions;
  private health: RuntimeHealth;
  private sessionManager: SessionManager | null = null;
  private session: AgentSession | null = null;
  private liveHistory: LiveHistoryPublisher | null = null;
  private checkoutCommit = "";
  private activity: "idle" | "busy" = "idle";
  private operationId: string | null = null;
  /** Operation ID promised to the requester before Pi emits agent_start. */
  private pendingOperationId: string | null = null;
  private readonly liveBlocks = new Map<string, LiveBlock>();
  private readonly liveTools = new Map<string, LiveTool>();
  private readonly listeners = new Set<FrameListener>();

  constructor(options: PiOrbAgentOptions) {
    this.options = options;
    this.health = this.initializing("booting");
  }

  private initializing(
    phase: "booting" | "cloning" | "loading_session" | "checking_auth",
  ): RuntimeHealth {
    return {
      v: 1,
      orbId: this.options.orbId,
      runtimeInstanceId: this.runtimeInstanceId,
      status: "initializing",
      phase,
    };
  }

  private failed(code: string, message: string, retryable: boolean): RuntimeHealth {
    return {
      v: 1,
      orbId: this.options.orbId,
      runtimeInstanceId: this.runtimeInstanceId,
      status: "failed",
      error: { code, message, retryable },
    };
  }

  getHealth(): RuntimeHealth {
    if (this.health.status !== "ready") return this.health;
    return {
      ...this.health,
      activity: this.activity,
      ...(this.operationId !== null ? { operationId: this.operationId } : {}),
    };
  }

  subscribe(listener: FrameListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private broadcast(frame: ServerFrame): void {
    for (const listener of this.listeners) listener(frame);
  }

  private broadcastEvent(event: RuntimeEvent): void {
    this.broadcast({ v: 1, type: "runtime.event", at: new Date().toISOString(), event });
  }

  // -- boot -----------------------------------------------------------------

  /** Expected init failures become `status: "failed"`; unexpected ones too. */
  async boot(): Promise<void> {
    const result = await this.bootSteps();
    if (result.isErr()) {
      this.health = result.error;
    }
  }

  private async bootSteps(): Promise<Result<void, RuntimeHealth>> {
    // 1. Clone (fresh temp dir + atomic rename; DESIGN.md §5.1).
    this.health = this.initializing("cloning");
    const repoDir = join(this.options.workDir, "repo");
    if (!existsSync(repoDir)) {
      // Re-validate before cloning: the first-slice database is writable by
      // anyone who can reach the control plane (DESIGN.md §11.1).
      const url = validateRepositoryUrl(this.options.repositoryUrl);
      if (url.isErr()) {
        return err(this.failed("invalid_repository_url", url.error.message, false));
      }
      const tmpDir = join(this.options.workDir, ".clone-tmp");
      const cleaned = Result.fromThrowable(
        () => {
          rmSync(tmpDir, { recursive: true, force: true });
          mkdirSync(this.options.workDir, { recursive: true });
        },
        (error) => String(error),
      )();
      if (cleaned.isErr()) return err(this.failed("clone_failed", cleaned.error, true));
      const cloned = await execGit(["clone", "--", url.value.url, tmpDir], this.options.workDir);
      if (cloned.isErr()) return err(this.failed("clone_failed", cloned.error.message, true));
      const renamed = Result.fromThrowable(
        () => renameSync(tmpDir, repoDir),
        (error) => String(error),
      )();
      if (renamed.isErr()) return err(this.failed("clone_failed", renamed.error, true));
    }
    const commit = await execGit(["rev-parse", "HEAD"], repoDir);
    if (commit.isErr()) return err(this.failed("clone_failed", commit.error.message, true));
    this.checkoutCommit = commit.value;

    // 2. Session: never replace an existing one (DESIGN.md §5.1).
    this.health = this.initializing("loading_session");
    const sessionDir = join(this.options.workDir, "pi-sessions");
    const managerResult = Result.fromThrowable(
      () => {
        mkdirSync(sessionDir, { recursive: true });
        // Whether to create or load is decided solely from the persistent
        // filesystem: an existing session must be loaded, and one that cannot
        // be loaded fails rather than being replaced (DESIGN.md §5.1).
        const existing = readdirSync(sessionDir)
          .filter((name) => name.endsWith(".jsonl"))
          .map((name) => join(sessionDir, name))
          .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
          .at(0);
        if (existing !== undefined) {
          return SessionManager.open(existing, sessionDir, repoDir);
        }
        return SessionManager.create(repoDir, sessionDir);
      },
      (error) => (error instanceof Error ? error.message : String(error)),
    )();
    if (managerResult.isErr()) {
      // A session that exists but cannot be loaded is non-retryable — never
      // grounds for creating a fresh session.
      return err(this.failed("session_load_failed", managerResult.error, false));
    }
    this.sessionManager = managerResult.value;

    // 3. Codex credential must resolve (DESIGN.md §5.1).
    this.health = this.initializing("checking_auth");
    const runtimeResult = await ResultAsync.fromPromise(
      ModelRuntime.create({ authPath: join(this.options.authDir, "auth.json") }),
      (error) => (error instanceof Error ? error.message : String(error)),
    );
    if (runtimeResult.isErr()) {
      return err(this.failed("auth_unavailable", runtimeResult.error, true));
    }
    const auth = await ResultAsync.fromPromise(
      runtimeResult.value.getAuth("openai-codex"),
      (error) => (error instanceof Error ? error.message : String(error)),
    );
    if (auth.isErr() || auth.value === undefined) {
      return err(
        this.failed(
          "credential_unavailable",
          auth.isErr() ? auth.error : "openai-codex credential did not resolve",
          true,
        ),
      );
    }

    // 4. Create the embedded session.
    const sessionResult = await ResultAsync.fromPromise(
      createAgentSession({
        cwd: repoDir,
        agentDir: join(this.options.workDir, "pi-agent"),
        modelRuntime: runtimeResult.value,
        sessionManager: this.sessionManager,
      }),
      (error) => (error instanceof Error ? error.message : String(error)),
    );
    if (sessionResult.isErr()) {
      return err(this.failed("session_init_failed", sessionResult.error, true));
    }
    this.session = sessionResult.value.session;
    const manager = this.sessionManager;
    this.liveHistory = new LiveHistoryPublisher(manager, (record) => {
      this.broadcast({
        v: 1,
        type: "history.record",
        at: new Date().toISOString(),
        record,
        headId: record.id,
      });
    });
    this.session.subscribe((event) => this.onAgentEvent(event));

    this.health = {
      v: 1,
      orbId: this.options.orbId,
      runtimeInstanceId: this.runtimeInstanceId,
      status: "ready",
      sessionId: manager.getSessionId(),
      checkoutCommit: this.checkoutCommit,
      activity: this.activity,
    };
    return ok(undefined);
  }

  // -- Pi event translation (DESIGN.md §6.3) --------------------------------

  private onAgentEvent(event: AgentSessionEvent): void {
    // Pi notifies subscribers of ordinary message_end before appending the
    // corresponding session entry. The publisher scans after that boundary
    // and flushes synchronously at agent_settled before live state is cleared.
    this.liveHistory?.observe(event.type);

    switch (event.type) {
      case "agent_start": {
        this.operationId = this.pendingOperationId ?? randomUUID();
        this.pendingOperationId = null;
        this.activity = "busy";
        this.liveBlocks.clear();
        this.liveTools.clear();
        this.broadcastEvent({ type: "operation_started", operationId: this.operationId });
        this.broadcastEvent({ type: "status", activity: "busy", operationId: this.operationId });
        break;
      }
      case "message_update": {
        if (this.operationId === null) break;
        const message = event.message as { role?: string; content?: unknown };
        if (message.role !== "assistant" || !Array.isArray(message.content)) break;
        message.content.forEach((block: unknown, index: number) => {
          if (typeof block !== "object" || block === null) return;
          const typed = block as { type?: string; text?: string; thinking?: string };
          const blockType =
            typed.type === "text" ? "text" : typed.type === "thinking" ? "reasoning" : null;
          if (blockType === null) return;
          const text = blockType === "text" ? (typed.text ?? "") : (typed.thinking ?? "");
          const blockId = `${this.operationId}-${index}`;
          const existing = this.liveBlocks.get(blockId);
          if (existing !== undefined && existing.text === text) return;
          const revision = (existing?.revision ?? 0) + 1;
          this.liveBlocks.set(blockId, { blockType, revision, text });
          if (this.operationId === null) return;
          this.broadcastEvent({
            type: "output_patch",
            operationId: this.operationId,
            blockId,
            blockType,
            revision,
            patch:
              existing !== undefined && text.startsWith(existing.text)
                ? { type: "append", text: text.slice(existing.text.length) }
                : { type: "replace", text },
          });
        });
        break;
      }
      case "tool_execution_start": {
        if (this.operationId === null) break;
        this.liveTools.set(event.toolCallId, {
          name: event.toolName,
          revision: 1,
          state: "running",
        });
        this.broadcastEvent({
          type: "tool_state",
          operationId: this.operationId,
          callId: event.toolCallId,
          name: event.toolName,
          revision: 1,
          state: "running",
        });
        break;
      }
      case "tool_execution_end": {
        if (this.operationId === null) break;
        const existing = this.liveTools.get(event.toolCallId);
        const revision = (existing?.revision ?? 0) + 1;
        const state = event.isError ? "failed" : "completed";
        this.liveTools.set(event.toolCallId, {
          name: event.toolName,
          revision,
          state,
        });
        this.broadcastEvent({
          type: "tool_state",
          operationId: this.operationId,
          callId: event.toolCallId,
          name: event.toolName,
          revision,
          state,
        });
        break;
      }
      case "agent_settled": {
        const operationId = this.operationId;
        this.operationId = null;
        this.activity = "idle";
        this.liveBlocks.clear();
        this.liveTools.clear();
        if (operationId !== null) {
          this.broadcastEvent({
            type: "operation_finished",
            operationId,
            outcome: "completed",
          });
        }
        this.broadcastEvent({ type: "status", activity: "idle" });
        break;
      }
      default:
        break;
    }
  }

  // -- synchronous views ----------------------------------------------------

  /** Immutable snapshot of the persisted session (DESIGN.md §8.1). */
  snapshot(): Result<HarnessSnapshot, SnapshotError> {
    const manager = this.sessionManager;
    if (manager === null || this.health.status !== "ready") {
      return err({ type: "snapshot_error", message: "session is not ready" });
    }
    const header = mapPiSessionHeader(manager.getHeader());
    if (header.isErr()) {
      return err({ type: "snapshot_error", message: header.error.message });
    }
    const records = [];
    for (const entry of manager.getEntries()) {
      const mapped = mapPiEntry(entry);
      // A mapping failure must fail the pull, never skip an entry (§9.2).
      if (mapped.isErr()) {
        return err({ type: "snapshot_error", message: mapped.error.message });
      }
      records.push(mapped.value);
    }
    return ok({
      orbId: this.options.orbId,
      runtimeInstanceId: this.runtimeInstanceId,
      activity: this.activity,
      session: header.value,
      records,
      headId: manager.getLeafId(),
    });
  }

  gateView(): AgentGateView {
    return {
      activity: this.activity,
      headId: this.sessionManager?.getLeafId() ?? null,
      activeOperationId: this.operationId,
    };
  }

  liveView(): LiveOperationView | null {
    if (this.operationId === null) return null;
    return {
      operationId: this.operationId,
      blocks: [...this.liveBlocks.entries()].map(([blockId, block]) => ({
        blockId,
        blockType: block.blockType,
        revision: block.revision,
        text: block.text,
      })),
      tools: [...this.liveTools.entries()].map(([callId, tool]) => ({
        callId,
        name: tool.name,
        revision: tool.revision,
        state: tool.state,
        ...(tool.message !== undefined ? { message: tool.message } : {}),
      })),
    };
  }

  sessionId(): string | null {
    return this.sessionManager?.getSessionId() ?? null;
  }

  /**
   * Submit a user message under the operation ID already promised to the
   * requester; resolves once Pi has accepted/persisted it.
   */
  submitMessage(text: string, operationId: string): ResultAsync<void, { message: string }> {
    const session = this.session;
    if (session === null) {
      return ResultAsync.fromSafePromise(Promise.resolve()).andThen(() =>
        err({ message: "session is not ready" }),
      );
    }
    this.pendingOperationId = operationId;
    return ResultAsync.fromPromise(Promise.resolve(session.sendUserMessage(text)), (error) => ({
      message: error instanceof Error ? error.message : String(error),
    })).map(() => undefined);
  }

  abortOperation(): ResultAsync<void, { message: string }> {
    const session = this.session;
    if (session === null) {
      return ResultAsync.fromSafePromise(Promise.resolve()).andThen(() =>
        err({ message: "session is not ready" }),
      );
    }
    return ResultAsync.fromPromise(session.abort(), (error) => ({
      message: error instanceof Error ? error.message : String(error),
    }));
  }
}

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { MockOpenAiConfig } from "@pi-orb/mock-openai";
import {
  type DeliverOrbMessageResponse,
  type MessageInputBlock,
  ORB_NAME_MESSAGE_MAX_BYTES,
  ORB_NAME_README_MAX_BYTES,
  type RuntimeEvent,
  type RuntimeHealth,
  type RuntimeHooks,
  type RuntimeTurnResume,
  type ServerFrame,
  validateRepositoryUrl,
} from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { err, ok, Result, ResultAsync } from "neverthrow";
import { type BrokerEnv, HttpBrokerEndpoint } from "../broker/endpoint.ts";
import { brokerProviderConfig } from "../broker/provider.ts";
import { BrokerTokenClient } from "../domain/broker-client.ts";
import { gateUnflushedSnapshot } from "../domain/history.ts";
import { configurePersistentHome } from "../domain/home.ts";
import type { AgentGateView } from "../domain/requests.ts";
import { ensurePersistentRustToolchain } from "../domain/rust.ts";
import {
  buildTurnSummaryInput,
  type TurnSummarizer,
  TurnSummaryCoordinator,
} from "../domain/turn-summary.ts";
import type { HarnessSnapshot, LiveOperationView } from "../domain/types.ts";
import type { HookSpawner } from "../hooks/ports.ts";
import { BootHookRunner } from "../hooks/runner.ts";
import { NodeHookSpawner } from "../hooks/spawner.ts";
import { triggerOrbName } from "../naming/client.ts";
import { readRootReadme } from "../naming/context.ts";
import { LiveHistoryPublisher } from "./live-history.ts";
import { LunaTurnSummarizer } from "./luna-summarizer.ts";
import { mapPiEntry, mapPiSessionHeader } from "./mapping.ts";
import { pickCodexModel } from "./model-select.ts";
import { createOrbResourceLoader } from "./resource-loader.ts";
import { sessionFlushed } from "./session-flush.ts";
import { describeTurnResumeDecision, startInterruptedTurnResume } from "./turn-resume.ts";

export interface PiOrbAgentOptions {
  readonly orbId: string;
  readonly repositoryUrl: string;
  /** Persistent orb filesystem root (the Docker volume). */
  readonly workDir: string;
  /** Control-plane broker access (docs/credentials.md); the only credential path. */
  readonly broker: BrokerEnv | null;
  /** E2E mode: route inference to the fake OpenAI service. */
  readonly mockOpenAi?: MockOpenAiConfig | null;
  /**
   * Tailnet FQDN the orb's ports are reachable at (docs/ports.md), or null
   * when tier-1 port exposure is off. Only the agent's system prompt uses it.
   */
  readonly previewHost?: string | null;
  /** Compute incarnation this boot belongs to; keys the setup hook's stamp. */
  readonly incarnation?: string;
  /** Test seam; production spawns the repository's boot hooks with `NodeHookSpawner`. */
  readonly hookSpawner?: HookSpawner;
  /** Test seam; production creates the Luna adapter from the orb's existing ModelRuntime. */
  readonly turnSummarizer?: TurnSummarizer;
  /** E2E composition seam: expose one selected incarnation as terminally failed. */
  readonly testLaunchFailure?: boolean;
}

export interface SnapshotError {
  readonly type: "snapshot_error";
  readonly message: string;
}

/**
 * The Pi session surface the adapter drives. Narrowing the SDK object to the
 * calls actually made is what lets deterministic tests stand in for Pi and
 * schedule its event delivery (docs/testing.md, docs/pi-adapter.md);
 * production always passes a real `AgentSession`.
 */
export type PiSession = Pick<
  AgentSession,
  "subscribe" | "sendUserMessage" | "sendCustomMessage" | "executeBash" | "abort" | "abortBash"
>;

/** The `SessionManager` surface the adapter reads, narrowed for the same reason. */
export type PiSessionManager = Pick<
  SessionManager,
  | "getEntries"
  | "getLeafId"
  | "getHeader"
  | "getSessionId"
  | "getSessionFile"
  | "buildContextEntries"
>;

type FrameListener = (frame: ServerFrame) => void;

interface LiveBlock {
  blockType: "text" | "reasoning" | "shell";
  revision: number;
  text: string;
}

interface LiveTool {
  name: string;
  revision: number;
  state: "running" | "completed" | "failed";
  message?: string;
}

const LIVE_SHELL_OUTPUT_LIMIT = 50 * 1024;
const LIVE_SHELL_TRUNCATION_MARKER = "[earlier live output truncated]\n";

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
  private sessionManager: PiSessionManager | null = null;
  private session: PiSession | null = null;
  private liveHistory: LiveHistoryPublisher | null = null;
  private checkoutCommit = "";
  private activity: "idle" | "busy" = "idle";
  /** This boot's interrupted-turn decision, when notable (docs/lifecycle.md). */
  private turnResume: RuntimeTurnResume | null = null;
  private operationId: string | null = null;
  private operationKind: "agent" | "shell" | null = null;
  /**
   * Set while an accepted agent submission is waiting for Pi to begin its
   * turn; resolves at `agent_start` or when the submission fails. Pi only
   * marks itself streaming when it begins the turn, which is later than the
   * runtime's own acceptance — handing Pi a second submission inside that
   * window makes it start a competing turn and refuse the loser ("Agent is
   * already processing"), so a delivery waits the window out before reading
   * activity (docs/pi-adapter.md).
   */
  private turnStart: { readonly promise: Promise<void>; readonly resolve: () => void } | null =
    null;
  private summaryStartIndex: number | null = null;
  private summaryCoordinator: TurnSummaryCoordinator | null = null;
  private shellCommand = "";
  private shellOutput = "";
  private shellOutputTruncated = false;
  private readonly liveBlocks = new Map<string, LiveBlock>();
  private readonly liveTools = new Map<string, LiveTool>();
  private readonly listeners = new Set<FrameListener>();
  private readonly pendingInboxMessages = new Map<
    string,
    { delivery: "turn" | "steer"; operationId: string }
  >();
  private autoNameTriggered = false;
  /** Created once the checkout exists; null before, and when hooks never ran. */
  private hooks: BootHookRunner | null = null;

  constructor(options: PiOrbAgentOptions) {
    this.options = options;
    this.health = this.initializing("booting");
  }

  private initializing(
    phase: "booting" | "cloning" | "setup_running" | "loading_session" | "checking_auth",
  ): RuntimeHealth {
    return {
      v: 1,
      orbId: this.options.orbId,
      runtimeInstanceId: this.runtimeInstanceId,
      status: "initializing",
      phase,
    };
  }

  /** Read at report time, not at transition time: a backgrounded resume finishes late. */
  private hookReport(): { hooks?: RuntimeHooks } {
    const report = this.hooks?.report();
    if (report === undefined || (report.setup === undefined && report.resume === undefined)) {
      return {};
    }
    return { hooks: report };
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
    if (this.health.status === "failed") return this.health;
    if (this.health.status !== "ready") return { ...this.health, ...this.hookReport() };
    return {
      ...this.health,
      activity: this.activity,
      ...(this.operationId !== null ? { operationId: this.operationId } : {}),
      ...(this.turnResume !== null ? { turnResume: this.turnResume } : {}),
      ...this.hookReport(),
    };
  }

  /** Terminates a resume hook that outlived its blocking window. */
  shutdownHooks(): void {
    this.hooks?.shutdown();
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
    if (this.options.testLaunchFailure === true) {
      return err(
        this.failed(
          "e2e_launch_failure",
          "test composition deliberately failed this compute incarnation",
          false,
        ),
      );
    }
    // 0. Home is ordinary durable orb state, not disposable container state
    // (docs/host-provider.md). Enforce this in the runtime as well as providers
    // so direct launches cannot inherit a shared or ephemeral host home.
    const home = configurePersistentHome(this.options.workDir);
    if (home.isErr()) {
      return err(this.failed("home_init_failed", home.error.message, false));
    }
    const rust = await ensurePersistentRustToolchain(home.value);
    if (rust.isErr()) {
      return err(this.failed("rust_toolchain_init_failed", rust.error.message, true));
    }

    // 1. Clone (fresh temp dir + atomic rename; docs/host-provider.md).
    this.health = this.initializing("cloning");
    const repoDir = join(this.options.workDir, "repo");
    if (!existsSync(repoDir)) {
      // Re-validate before cloning: the first-slice database is writable by
      // anyone who can reach the control plane (docs/control-plane-api.md).
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

    // 1b. The repository's `.agents/setup` (docs/orb-setup-hook.md) — it needs
    // the checkout, and everything after it may depend on what it installs.
    // Readiness is held while it runs; its failure never fails the boot.
    this.hooks = new BootHookRunner({
      repoDir,
      home: home.value,
      workDir: this.options.workDir,
      incarnation: this.options.incarnation ?? "0",
      task: new NoSimulationTask(`hooks-${this.options.orbId}`, false),
      spawner: this.options.hookSpawner ?? new NodeHookSpawner(),
      environment: process.env,
      log: (line) => console.log(line),
      onSetupStart: () => {
        this.health = this.initializing("setup_running");
      },
    });
    await this.hooks.runSetup();

    // 2. Session: never replace an existing one (docs/host-provider.md).
    this.health = this.initializing("loading_session");
    const sessionDir = join(this.options.workDir, "pi-sessions");
    const managerResult = Result.fromThrowable(
      () => {
        mkdirSync(sessionDir, { recursive: true });
        // Whether to create or load is decided solely from the persistent
        // filesystem: an existing session must be loaded, and one that cannot
        // be loaded fails rather than being replaced (docs/host-provider.md).
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
    const sessionManager = managerResult.value;
    this.sessionManager = sessionManager;

    // 3. Codex credential resolves through the control-plane broker
    // (docs/credentials.md) — the only credential path on every provider.
    this.health = this.initializing("checking_auth");
    const mockOpenAi = this.options.mockOpenAi ?? null;
    const broker = this.options.broker;
    if (broker === null) {
      return err(
        this.failed("auth_unavailable", "broker environment variables are missing", false),
      );
    }
    const brokerTask = new NoSimulationTask(`broker-${this.options.orbId}`, false);
    const brokerClient = new BrokerTokenClient(new HttpBrokerEndpoint(broker, "model"));
    const runtimeResult = await ResultAsync.fromPromise(
      ModelRuntime.create({
        // Private per-orb auth file: holds only the short-lived access token
        // and the synthetic broker marker, never a refresh token.
        authPath: join(this.options.workDir, "pi-auth.json"),
        // Codex resolves offline from the built-in catalog; the availability
        // sweep in ModelRuntime.login can stall boots for minutes.
        allowModelNetwork: false,
      }),
      (error) => (error instanceof Error ? error.message : String(error)),
    );
    if (runtimeResult.isErr()) {
      return err(this.failed("auth_unavailable", runtimeResult.error, true));
    }
    const modelRuntime = runtimeResult.value;
    modelRuntime.registerProvider(
      "openai-codex",
      brokerProviderConfig(brokerTask, brokerClient, {
        // E2E mode routes inference to the fake service; Pi keeps its
        // built-in Codex catalog and parser (docs/PI-CODEX-E2E.md).
        ...(mockOpenAi !== null ? { inferenceBaseUrl: mockOpenAi.inferenceBaseUrl } : {}),
      }),
    );
    const auth = await ResultAsync.fromPromise(modelRuntime.getAuth("openai-codex"), (error) =>
      error instanceof Error ? error.message : String(error),
    );
    if (auth.isErr()) {
      return err(this.failed("credential_unavailable", auth.error, true));
    }
    if (auth.value === undefined) {
      // First boot of this incarnation: pull the initial token. Pi drives
      // our broker-backed oauth `login`; no prompts are involved.
      const login = await ResultAsync.fromPromise(
        modelRuntime.login("openai-codex", "oauth", {
          prompt: (prompt) => {
            if (prompt.type === "select") {
              const first = prompt.options[0];
              if (first !== undefined) return Promise.resolve(first.id);
            }
            return Promise.reject(new Error(`unsupported auth prompt: ${prompt.type}`));
          },
          notify: () => {},
        }),
        (error) => (error instanceof Error ? error.message : String(error)),
      );
      if (login.isErr()) {
        return err(this.failed("credential_unavailable", login.error, true));
      }
    }

    // 4. Create the embedded session, pinned to the Codex model.
    const refreshed = await ResultAsync.fromPromise(
      modelRuntime.refresh({ allowNetwork: false }),
      (error) => (error instanceof Error ? error.message : String(error)),
    );
    if (refreshed.isErr()) {
      return err(this.failed("session_init_failed", refreshed.error, true));
    }
    const model = pickCodexModel(modelRuntime.getModels("openai-codex"));
    if (model === undefined) {
      return err(this.failed("session_init_failed", "no openai-codex model available", true));
    }
    // 3b. `.agents/resume` runs after setup and before the session exists, so
    // the agent's first turn already sees whatever it authenticated. Its
    // outcome is awaited only for the blocking window; a slower hook keeps
    // running and only the prompt fragment misses it (docs/orb-setup-hook.md).
    await this.hooks.runResume();
    // Both hooks have had their say, so whatever they wrote to the env file is
    // merged into the runtime's own environment here — the last moment before
    // the agent exists, and what its `bash -c` tool shells and the terminal's
    // PTYs inherit. Nothing a hook *exported* ever reaches either shell
    // (docs/orb-setup-hook.md).
    const hookEnv = await this.hooks.applyHookEnv(process.env);

    const agentDir = join(this.options.workDir, "pi-agent");
    // SSE keeps the first E2E deterministic; the fake refuses the WebSocket
    // transport (docs/PI-CODEX-E2E.md).
    const settingsManager =
      mockOpenAi !== null ? SettingsManager.inMemory({ transport: "sse" }) : undefined;
    // Runtime-tool availability is always appended to Pi's system prompt;
    // optional tier-1 port exposure composes through the same resource loader.
    const loaderResult = await createOrbResourceLoader({
      cwd: repoDir,
      agentDir,
      settingsManager,
      previewHost: this.options.previewHost ?? null,
      hooks: this.hooks.report(),
      hookEnv,
    });
    if (loaderResult.isErr()) {
      return err(this.failed("session_init_failed", loaderResult.error, true));
    }
    const sessionResult = await ResultAsync.fromPromise(
      createAgentSession({
        cwd: repoDir,
        agentDir,
        modelRuntime,
        sessionManager,
        model,
        ...(settingsManager !== undefined ? { settingsManager } : {}),
        resourceLoader: loaderResult.value,
      }),
      (error) => (error instanceof Error ? error.message : String(error)),
    );
    if (sessionResult.isErr()) {
      return err(this.failed("session_init_failed", sessionResult.error, true));
    }
    const summarizer = this.options.turnSummarizer ?? new LunaTurnSummarizer(modelRuntime, model);
    this.attachSession(sessionResult.value.session, sessionManager, summarizer);
    return ok(undefined);
  }

  /**
   * Boot's final step, separated as the harness seam (docs/testing.md): wire
   * the live publisher, the summary coordinator, and the Pi event
   * subscription around a created session, report ready, and run the
   * interrupted-turn hook. Deterministic tests drive this directly with a
   * scheduled fake session instead of booting a model runtime.
   */
  attachSession(session: PiSession, manager: PiSessionManager, summarizer: TurnSummarizer): void {
    this.session = session;
    this.sessionManager = manager;
    this.summaryCoordinator = new TurnSummaryCoordinator({
      task: new NoSimulationTask(`turn-summary-${this.options.orbId}`, false),
      summarizer,
      timeoutMs: 15_000,
      maxConcurrency: 2,
      maxQueued: 8,
      onSummary: (operationId, summary) => {
        console.log(
          `Luna summary completed operation=${operationId} chars=${summary.length} live_connections=${this.listeners.size}`,
        );
        this.broadcastEvent({ type: "turn_notification", operationId, summary });
      },
      onError: (operationId, error) => {
        console.error(`Luna summary failed for operation ${operationId}: ${error.message}`);
      },
    });
    this.liveHistory = new LiveHistoryPublisher(manager, (record) => {
      const native = record.overflow["native"];
      if (typeof native === "object" && native !== null && !Array.isArray(native)) {
        const details = native["details"];
        if (
          native["type"] === "custom_message" &&
          native["customType"] === "pi-orb.user-message" &&
          typeof details === "object" &&
          details !== null &&
          !Array.isArray(details)
        ) {
          const messageIds = details["messageIds"];
          const batchId = Array.isArray(messageIds) ? messageIds[0] : details["messageId"];
          if (typeof batchId === "string") this.pendingInboxMessages.delete(batchId);
        }
      }
      this.broadcast({
        v: 1,
        type: "history.record",
        at: new Date().toISOString(),
        record,
        headId: record.id,
      });
    });
    session.subscribe((event) => this.onAgentEvent(event));

    this.health = {
      v: 1,
      orbId: this.options.orbId,
      runtimeInstanceId: this.runtimeInstanceId,
      status: "ready",
      sessionId: manager.getSessionId(),
      checkoutCommit: this.checkoutCommit,
      activity: this.activity,
    };
    const firstUser = this.snapshot().map((snapshot) =>
      snapshot.records.find((record) => record.type === "message" && record.role === "user"),
    );
    if (firstUser.isOk() && firstUser.value !== undefined && firstUser.value.type === "message") {
      const content: MessageInputBlock[] = firstUser.value.content.flatMap(
        (block): MessageInputBlock[] =>
          block.type === "text"
            ? [{ type: "text" as const, text: block.text }]
            : block.type === "image"
              ? [{ type: "image" as const, mediaType: block.mediaType ?? "image/png", data: "" }]
              : [],
      );
      this.triggerAutoName(content);
    }

    // 5. Resume a turn a host restart interrupted (docs/lifecycle.md). The
    // runtime is already ready here: the resumed turn is never awaited, and it
    // surfaces as ordinary `busy` activity through Pi's agent_start.
    this.resumeInterruptedTurn(manager, session);
  }

  /**
   * Boot's interrupted-turn hook. The marker is appended and its turn is
   * triggered without blocking readiness — with `triggerTurn` the SDK settles
   * its promise only when the whole resumed turn does, so awaiting it here
   * would hold the runtime in `initializing` for the length of a turn. The
   * decision is kept for `RuntimeHealth`, where the control plane's readiness
   * path turns it into one log line (docs/lifecycle.md).
   */
  private resumeInterruptedTurn(manager: PiSessionManager, session: PiSession): void {
    // The LiveHistoryPublisher already seeded the restored entries as known,
    // so the record appended below publishes and replicates normally.
    const attempt = startInterruptedTurnResume(manager.buildContextEntries(), session);
    this.turnResume = attempt.observation;
    console.log(`${describeTurnResumeDecision(attempt.decision)} orb=${this.options.orbId}`);
    const issued = attempt.issued;
    if (issued === null) return;
    const customType = attempt.marker?.customType ?? "";
    void issued.mapErr((error) => {
      console.error(`turn-resume: ${customType} record failed: ${error.message}`);
      // A resume the harness refused never happened: health must not claim it
      // did. A failed decline record leaves the decline itself standing.
      if (this.turnResume?.outcome === "resumed") {
        this.turnResume = { ...this.turnResume, outcome: "resume_failed" };
      }
      return error;
    });
  }

  // -- Pi event translation (docs/runtime-protocol.md) --------------------------------

  private onAgentEvent(event: AgentSessionEvent): void {
    // Pi notifies subscribers of ordinary message_end before appending the
    // corresponding session entry. The publisher scans after that boundary
    // and flushes synchronously at agent_settled before live state is cleared.
    this.liveHistory?.observe(event.type);

    switch (event.type) {
      case "agent_start": {
        // A submitted turn claimed its operation synchronously at acceptance,
        // and Pi re-emits agent_start for continuations inside the same run
        // (auto-retry, auto-compaction): neither may restart the operation or
        // change its ID. Only a turn nobody submitted — the boot
        // interrupted-turn resume (docs/lifecycle.md) — allocates here.
        if (this.operationKind === null) this.startAgentOperation(randomUUID(), null);
        this.settleTurnStart();
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
        if (this.operationKind !== "agent") break;
        const operationId = this.operationId;
        const summaryInput = this.captureTurnSummaryInput();
        this.finishAgentOperation(operationId, "completed");
        if (operationId !== null && summaryInput !== null) {
          // Agent completion is already visible and the runtime is idle. Luna runs strictly
          // best-effort in the background and cannot change this operation's outcome.
          console.log(
            `Luna summary queued operation=${operationId} input_chars=${summaryInput.transcript.length}`,
          );
          this.summaryCoordinator?.enqueue(operationId, summaryInput);
        } else if (operationId !== null) {
          console.error(
            `Luna summary skipped operation=${operationId}: no turn input was captured`,
          );
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * Claim the runtime for an agent operation at the instant its submission is
   * accepted, exactly as a shell submission does (docs/runtime-protocol.md).
   * Activity is what both ingress paths gate on, so it must not lag
   * acceptance: a second submitter reading `idle` during the window before
   * Pi's `agent_start` would be promised an operation ID for a turn that
   * never becomes its own.
   */
  private startAgentOperation(operationId: string, summaryStartIndex: number | null): void {
    this.operationId = operationId;
    this.operationKind = "agent";
    this.activity = "busy";
    this.summaryStartIndex = summaryStartIndex;
    this.liveBlocks.clear();
    this.liveTools.clear();
    this.broadcastEvent({ type: "operation_started", operationId });
    this.broadcastEvent({ type: "status", activity: "busy", operationId });
  }

  private finishAgentOperation(
    operationId: string | null,
    outcome: "completed" | "failed",
    message?: string,
  ): void {
    this.operationId = null;
    this.operationKind = null;
    this.activity = "idle";
    this.liveBlocks.clear();
    this.liveTools.clear();
    // A turn that ends without ever starting still releases its waiters.
    this.settleTurnStart();
    if (operationId !== null) {
      this.broadcastEvent({
        type: "operation_finished",
        operationId,
        outcome,
        ...(message !== undefined ? { message } : {}),
      });
    }
    this.broadcastEvent({ type: "status", activity: "idle" });
  }

  /**
   * A submission Pi refused releases the operation it claimed, so the runtime
   * cannot be left busy on a turn that will never run — and the failure is
   * visible to the browser as a finished operation instead of silence.
   */
  private abandonAgentOperation(operationId: string, message: string): void {
    if (this.operationId !== operationId || this.operationKind !== "agent") return;
    this.summaryStartIndex = null;
    this.finishAgentOperation(operationId, "failed", message);
  }

  /** Resolves once no accepted submission is still waiting for `agent_start`. */
  private awaitTurnStart(): Promise<void> {
    return this.turnStart?.promise ?? Promise.resolve();
  }

  private beginTurnStart(): void {
    if (this.turnStart !== null) return;
    let resolve = (): void => {};
    const promise = new Promise<void>((settle) => {
      resolve = settle;
    });
    this.turnStart = { promise, resolve };
  }

  private settleTurnStart(): void {
    const pending = this.turnStart;
    this.turnStart = null;
    pending?.resolve();
  }

  private captureTurnSummaryInput() {
    const manager = this.sessionManager;
    const startIndex = this.summaryStartIndex;
    this.summaryStartIndex = null;
    if (manager === null || startIndex === null) return null;

    const records = [];
    for (const entry of manager.getEntries().slice(startIndex)) {
      const mapped = mapPiEntry(entry);
      if (mapped.isErr()) {
        console.error(`Luna summary input mapping failed: ${mapped.error.message}`);
        return null;
      }
      records.push(mapped.value);
    }
    return buildTurnSummaryInput(records);
  }

  // -- synchronous views ----------------------------------------------------

  /**
   * The snapshot served to the control plane's history pull
   * (docs/history-replication.md): empty until the SDK has written the session file (no assistant
   * message yet, pinned in session-flush.contract.test.ts), because every
   * entry before that is memory-only and a committed cursor naming one would
   * be unresolvable after a restart. Browser-facing views use `snapshot()`
   * ungated — gating only part of them desynchronizes the head the client
   * sees from the head its requests are validated against (stale_head).
   */
  replicationSnapshot(): Result<HarnessSnapshot, SnapshotError> {
    const manager = this.sessionManager;
    if (manager === null) {
      return err({ type: "snapshot_error", message: "session is not ready" });
    }
    return this.snapshot().map((snapshot) =>
      gateUnflushedSnapshot(snapshot, sessionFlushed(manager)),
    );
  }

  /** Immutable snapshot of the full in-memory session (docs/history-replication.md). */
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
      // A mapping failure must fail the pull, never skip an entry (docs/pi-adapter.md).
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
      operationKind: this.operationKind ?? "agent",
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

  /** Trigger first-message naming without delaying or failing the agent turn. */
  triggerAutoName(content: readonly MessageInputBlock[]): void {
    if (this.autoNameTriggered) return;
    this.autoNameTriggered = true;
    const broker = this.options.broker;
    if (broker === null) return;
    const text = content
      .filter(
        (block): block is Extract<MessageInputBlock, { type: "text" }> => block.type === "text",
      )
      .map((block) => block.text)
      .join("\n");
    const textBytes = Buffer.from(text);
    const boundedText = textBytes.subarray(0, ORB_NAME_MESSAGE_MAX_BYTES).toString("utf8");
    const imageOnly = boundedText.trim() === "" && content.some((block) => block.type === "image");
    const checkoutDir = join(this.options.workDir, "repo");
    void readRootReadme(checkoutDir, ORB_NAME_README_MAX_BYTES).then(async (readme) => {
      const sent = await triggerOrbName(broker, {
        text: boundedText,
        imageOnly,
        ...(readme.isOk() && readme.value !== null ? { readme: readme.value } : {}),
      });
      if (sent.isErr()) console.error(`orb naming unavailable: ${sent.error.message}`);
    });
  }

  /**
   * Deliver one frozen inbox batch (docs/runtime-protocol.md). The delivery
   * classification is derived from the runtime's activity at the instant of
   * the call, so the call first waits out any accepted submission that has
   * not reached `agent_start` yet: inside that window Pi still looks idle to
   * itself, and a message the runtime classified as a steer would start a
   * second, competing turn.
   */
  deliverInboxMessage(
    messageId: string,
    messageIds: readonly string[],
    content: readonly MessageInputBlock[],
  ): ResultAsync<DeliverOrbMessageResponse, { message: string; retryable: boolean }> {
    return ResultAsync.fromSafePromise(this.awaitTurnStart()).andThen(() =>
      this.deliverSettledInboxMessage(messageId, messageIds, content),
    );
  }

  private deliverSettledInboxMessage(
    messageId: string,
    messageIds: readonly string[],
    content: readonly MessageInputBlock[],
  ): ResultAsync<DeliverOrbMessageResponse, { message: string; retryable: boolean }> {
    const session = this.session;
    const manager = this.sessionManager;
    if (session === null || manager === null || this.health.status !== "ready") {
      return ResultAsync.fromSafePromise(Promise.resolve()).andThen(() =>
        err({ message: "session is not ready", retryable: true }),
      );
    }
    for (const entry of manager.getEntries()) {
      if (typeof entry !== "object" || entry === null) continue;
      const native = entry as { type?: string; customType?: string; details?: unknown };
      if (native.type !== "custom_message" || native.customType !== "pi-orb.user-message") continue;
      const details = native.details;
      if (typeof details !== "object" || details === null) continue;
      const typed = details as {
        messageId?: unknown;
        messageIds?: unknown;
        delivery?: unknown;
        operationId?: unknown;
      };
      const persistedIds = Array.isArray(typed.messageIds) ? typed.messageIds : [typed.messageId];
      if (persistedIds[0] !== messageId) continue;
      return ResultAsync.fromSafePromise(
        Promise.resolve({
          v: 1 as const,
          messageId,
          status: "persisted" as const,
          delivery: typed.delivery === "steer" ? ("steer" as const) : ("turn" as const),
          operationId: typeof typed.operationId === "string" ? typed.operationId : "unknown",
          duplicate: true,
        }),
      );
    }
    const pending = this.pendingInboxMessages.get(messageId);
    if (pending !== undefined) {
      return ResultAsync.fromSafePromise(
        Promise.resolve({
          v: 1 as const,
          messageId,
          status: "queued" as const,
          ...pending,
          duplicate: true,
        }),
      );
    }
    if (this.operationKind === "shell") {
      return ResultAsync.fromSafePromise(Promise.resolve()).andThen(() =>
        err({ message: "a foreground shell command is running", retryable: true }),
      );
    }
    const delivery: "turn" | "steer" = this.activity === "busy" ? "steer" : "turn";
    const operationId = delivery === "steer" ? (this.operationId ?? randomUUID()) : randomUUID();
    this.pendingInboxMessages.set(messageId, { delivery, operationId });
    if (delivery === "turn") {
      this.startAgentOperation(operationId, manager.getEntries().length);
      this.beginTurnStart();
    }
    const piContent = content.map((block) =>
      block.type === "text"
        ? { type: "text" as const, text: block.text }
        : { type: "image" as const, data: block.data, mimeType: block.mediaType },
    );
    this.triggerAutoName(content);
    return ResultAsync.fromPromise(
      session.sendCustomMessage(
        {
          customType: "pi-orb.user-message",
          content: piContent,
          display: true,
          details: { messageIds, delivery, operationId },
        },
        { triggerTurn: true, ...(delivery === "steer" ? { deliverAs: "steer" as const } : {}) },
      ),
      (error) => ({
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      }),
    )
      .map(() => ({
        v: 1 as const,
        messageId,
        status: "queued" as const,
        delivery,
        operationId,
        duplicate: false,
      }))
      .mapErr((error) => {
        this.pendingInboxMessages.delete(messageId);
        if (delivery === "turn") this.abandonAgentOperation(operationId, error.message);
        return error;
      });
  }

  /**
   * Submit a user message under the operation ID already promised to the
   * requester; resolves once Pi has accepted/persisted it. The operation is
   * claimed here, synchronously with acceptance, so no concurrent submitter
   * can be handed the same turn.
   */
  submitMessage(
    content: readonly MessageInputBlock[],
    operationId: string,
  ): ResultAsync<void, { message: string }> {
    const session = this.session;
    if (session === null) {
      return ResultAsync.fromSafePromise(Promise.resolve()).andThen(() =>
        err({ message: "session is not ready" }),
      );
    }
    this.startAgentOperation(operationId, this.sessionManager?.getEntries().length ?? null);
    this.beginTurnStart();
    const piContent = content.map((block) =>
      block.type === "text"
        ? { type: "text" as const, text: block.text }
        : { type: "image" as const, data: block.data, mimeType: block.mediaType },
    );
    return ResultAsync.fromPromise(
      Promise.resolve(session.sendUserMessage(piContent)),
      (error) => ({
        message: error instanceof Error ? error.message : String(error),
      }),
    )
      .map(() => undefined)
      .mapErr((error) => {
        this.abandonAgentOperation(operationId, error.message);
        return error;
      });
  }

  submitShell(
    command: string,
    excludeFromContext: boolean,
    operationId: string,
  ): ResultAsync<void, { message: string }> {
    const session = this.session;
    if (session === null) {
      return ResultAsync.fromSafePromise(Promise.resolve()).andThen(() =>
        err({ message: "session is not ready" }),
      );
    }

    this.startShellOperation(command, operationId);
    const execution = ResultAsync.fromPromise(
      session.executeBash(command, (chunk) => this.appendShellOutput(operationId, chunk), {
        excludeFromContext,
      }),
      (error) => ({ message: error instanceof Error ? error.message : String(error) }),
    );

    return execution
      .andThen((result) => {
        const flushed = this.liveHistory?.flushPersisted();
        if (flushed?.isErr()) return err({ message: flushed.error.message });
        this.finishShellOperation(operationId, result.cancelled ? "aborted" : "completed");
        return ok(undefined);
      })
      .mapErr((error) => {
        this.finishShellOperation(operationId, "failed", error.message);
        return error;
      });
  }

  private startShellOperation(command: string, operationId: string): void {
    this.operationId = operationId;
    this.operationKind = "shell";
    this.activity = "busy";
    this.shellCommand = command;
    this.shellOutput = "";
    this.shellOutputTruncated = false;
    this.liveBlocks.clear();
    this.liveTools.clear();

    const blockId = `${operationId}-shell`;
    this.liveBlocks.set(blockId, { blockType: "shell", revision: 1, text: `$ ${command}` });
    this.broadcastEvent({ type: "operation_started", operationId });
    this.broadcastEvent({ type: "status", activity: "busy", operationId });
    this.broadcastEvent({
      type: "output_patch",
      operationId,
      blockId,
      blockType: "shell",
      revision: 1,
      patch: { type: "replace", text: `$ ${command}` },
    });
  }

  private appendShellOutput(operationId: string, chunk: string): void {
    if (this.operationId !== operationId || this.operationKind !== "shell") return;
    const previous = this.liveBlocks.get(`${operationId}-shell`);
    this.shellOutput += chunk;
    if (this.shellOutput.length > LIVE_SHELL_OUTPUT_LIMIT) {
      this.shellOutput = this.shellOutput.slice(-LIVE_SHELL_OUTPUT_LIMIT);
      this.shellOutputTruncated = true;
    }
    const output = `${this.shellOutputTruncated ? LIVE_SHELL_TRUNCATION_MARKER : ""}${this.shellOutput}`;
    const text = `$ ${this.shellCommand}\n${output}`;
    const revision = (previous?.revision ?? 0) + 1;
    this.liveBlocks.set(`${operationId}-shell`, { blockType: "shell", revision, text });
    this.broadcastEvent({
      type: "output_patch",
      operationId,
      blockId: `${operationId}-shell`,
      blockType: "shell",
      revision,
      patch:
        previous !== undefined && text.startsWith(previous.text)
          ? { type: "append", text: text.slice(previous.text.length) }
          : { type: "replace", text },
    });
  }

  private finishShellOperation(
    operationId: string,
    outcome: "completed" | "aborted" | "failed",
    message?: string,
  ): void {
    if (this.operationId !== operationId || this.operationKind !== "shell") return;
    this.operationId = null;
    this.operationKind = null;
    this.activity = "idle";
    this.shellCommand = "";
    this.shellOutput = "";
    this.shellOutputTruncated = false;
    this.liveBlocks.clear();
    this.liveTools.clear();
    this.broadcastEvent({
      type: "operation_finished",
      operationId,
      outcome,
      ...(message !== undefined ? { message } : {}),
    });
    this.broadcastEvent({ type: "status", activity: "idle" });
  }

  abortOperation(): ResultAsync<void, { message: string }> {
    const session = this.session;
    if (session === null) {
      return ResultAsync.fromSafePromise(Promise.resolve()).andThen(() =>
        err({ message: "session is not ready" }),
      );
    }
    if (this.operationKind === "shell") {
      return ResultAsync.fromPromise(
        Promise.resolve().then(() => session.abortBash()),
        (error) => ({ message: error instanceof Error ? error.message : String(error) }),
      );
    }
    return ResultAsync.fromPromise(session.abort(), (error) => ({
      message: error instanceof Error ? error.message : String(error),
    }));
  }
}

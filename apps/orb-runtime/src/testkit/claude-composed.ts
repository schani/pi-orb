import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Options,
  SDKHookResponseMessage,
  SDKHookStartedMessage,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ServerFrame } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { ok } from "neverthrow";
import { ClaudeOrbAgent, type ClaudeQuery, type NativeState } from "../claude/agent.ts";
import { ClaudeHistory, nativeHistoryFiles } from "../claude/history.ts";

function latch() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
}

/** Only the SDK process is fake: journals, fsync, normalization and admission are production code. */
export class ComposedClaudeFixture {
  readonly dir = mkdtempSync(join(tmpdir(), "claude-composed-dst-"));
  readonly configDir = join(this.dir, "config");
  readonly nativeDir = join(this.configDir, "projects", "workspace");
  readonly state: NativeState = {
    id: "a994788d-2476-42d4-950c-ccbf33050cdd",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: this.dir,
    deliveries: {},
  };
  readonly nativePath = join(this.nativeDir, `${this.state.id}.jsonl`);
  readonly frames: ServerFrame[] = [];
  readonly queries: ScheduledClaudeQuery[] = [];
  readonly history: ClaudeHistory;
  readonly agent: ClaudeOrbAgent;
  failCommit = false;
  failSync = false;
  constructor() {
    mkdirSync(join(this.dir, "claude"));
    mkdirSync(this.nativeDir, { recursive: true });
    this.history = new ClaudeHistory(
      join(this.dir, "claude"),
      this.state.id,
      this.state.timestamp,
      {
        ...nativeHistoryFiles,
        commit: (path, text) => {
          if (this.failCommit) throw new Error("injected history commit failure");
          nativeHistoryFiles.commit(path, text);
        },
        sync: (path) => {
          if (this.failSync) throw new Error("injected native fsync failure");
          nativeHistoryFiles.sync(path);
        },
      },
    );
    this.agent = new ClaudeOrbAgent({
      orbId: "orb-a",
      repositoryUrl: "https://example.com/repo",
      workDir: this.dir,
      skillsDir: null,
      broker: null,
      incarnation: "0",
      sdkFactory: (input, options) => {
        const query = new ScheduledClaudeQuery(input, options, this.queries.length === 0);
        this.queries.push(query);
        return ok({
          query,
          exited: query.processExit.promise,
          stdoutEnded: query.stdoutEnded,
          requestShutdown: () => query.requestShutdown(),
        });
      },
    });
    this.agent.subscribe((frame) => this.frames.push(frame));
  }
  attach() {
    return this.agent.attachSession(this.state, this.history, this.configDir, "commit-0");
  }
  get query(): ScheduledClaudeQuery {
    const value = this.queries.at(-1);
    if (value === undefined) throw new Error("fixture query not initialized");
    return value;
  }
  append(entry: object) {
    appendFileSync(this.nativePath, `${JSON.stringify(entry)}\n`);
  }
  childFile() {
    const directory = join(this.nativeDir, this.state.id, "subagents");
    mkdirSync(directory, { recursive: true });
    appendFileSync(
      join(directory, "agent-child.jsonl"),
      `${JSON.stringify({
        type: "assistant",
        uuid: "private-child",
        message: { content: "private child secret" },
      })}\n`,
    );
  }
  journal(): NativeState {
    return JSON.parse(readFileSync(join(this.dir, "claude", "session.json"), "utf8"));
  }
  receipt(message: SDKUserMessage) {
    this.append({
      type: "user",
      uuid: message.uuid,
      timestamp: this.state.timestamp,
      message: message.message,
    });
  }
  dispose() {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

export class ScheduledClaudeQuery implements ClaudeQuery {
  readonly processExit = latch();
  private readonly outputEOF = latch();
  readonly stdoutEnded = this.outputEOF.promise.then(() => ok(undefined));
  readonly input: AsyncIterator<SDKUserMessage>;
  closeRequested = false;
  private outputEnded = false;
  private publicEnded = false;
  private wake = latch();
  private messages: { message: SDKMessage; consumed: ReturnType<typeof latch> }[] = [];
  readonly options: Options;
  private readonly metadata: boolean;
  constructor(input: AsyncIterable<SDKUserMessage>, options: Options, metadata: boolean) {
    this.input = input[Symbol.asyncIterator]();
    this.options = options;
    this.metadata = metadata;
  }
  async *[Symbol.asyncIterator]() {
    while (!this.publicEnded && (!this.outputEnded || this.messages.length > 0)) {
      const entry = this.messages.shift();
      if (entry === undefined) {
        await this.wake.promise;
        this.wake = latch();
      } else {
        yield entry.message;
        entry.consumed.release();
      }
    }
  }
  close() {
    this.publicEnded = true;
    this.wake.release();
  }
  requestShutdown() {
    this.closeRequested = true;
    if (this.metadata) {
      this.exit();
      this.endOutput();
    }
    return ok(undefined);
  }
  interrupt = async () => undefined;
  accountInfo = async () => ({
    apiProvider: "firstParty" as const,
    tokenSource: "CLAUDE_CODE_OAUTH_TOKEN" as const,
  });
  supportedModels = async () => [
    {
      value: "opus",
      displayName: "Opus",
      description: "",
      supportedEffortLevels: ["high" as const],
    },
  ];
  setModel = async () => undefined;
  applyFlagSettings = async () => undefined;
  async emit(task: SimulationTask, message: SDKMessage) {
    await task.checkpoint(`native stdout: ${message.type}`);
    if (this.outputEnded) return false;
    const consumed = latch();
    this.messages.push({ message, consumed });
    this.wake.release();
    await consumed.promise;
    return true;
  }
  exit() {
    this.processExit.release();
  }
  endOutput() {
    this.outputEnded = true;
    this.outputEOF.release();
    this.wake.release();
  }
}

export function nativeHook(
  hook_id: string,
  hook_event: string = "SessionStart",
): SDKHookStartedMessage {
  return {
    type: "system",
    subtype: "hook_started",
    hook_id,
    hook_name: "private-hook-command",
    hook_event,
    uuid: "11111111-1111-4111-8111-111111111111",
    session_id: "session",
  };
}
export function nativeHookResponse(
  started: SDKHookStartedMessage,
  outcome: SDKHookResponseMessage["outcome"] = "success",
): SDKHookResponseMessage {
  return {
    ...started,
    subtype: "hook_response",
    uuid: "22222222-2222-4222-8222-222222222222",
    outcome,
    stdout: "private-hook-output",
    stderr: "private-hook-stderr",
    output: "private-hook-output",
    exit_code: 0,
  };
}

export const rootResult = {
  type: "result",
  subtype: "success",
  is_error: false,
} as unknown as SDKMessage;
export const childEdge = (subtype: "task_started" | "task_notification") =>
  ({
    type: "system",
    subtype,
    task_id: "child",
    description: "child",
    status: "completed",
    task_type: "local_agent",
    uuid: `${subtype}-event`,
    session_id: "session",
  }) as unknown as SDKMessage;
export const background = (tasks: { task_id: string; description: string }[]) =>
  ({
    type: "system",
    subtype: "background_tasks_changed",
    tasks,
    uuid: "inventory",
    session_id: "session",
  }) as unknown as SDKMessage;

export async function submitReceipt(task: SimulationTask, fixture: ComposedClaudeFixture) {
  await task.checkpoint("durable inbox admission");
  const accepted = await fixture.agent.deliverInboxMessage(
    "inbox",
    ["inbox"],
    [{ type: "text", text: "hello" }],
  );
  if (accepted.isErr()) throw new Error(accepted.error.message);
  const message = await fixture.query.input.next();
  if (message.done === true) throw new Error("SDK input ended before admitted input");
  fixture.receipt(message.value);
  return message.value;
}

export async function childHook(task: SimulationTask, fixture: ComposedClaudeFixture) {
  await task.checkpoint("native SubagentStart before inference");
  const callback = fixture.query.options.hooks?.SubagentStart?.[0]?.hooks[0];
  if (callback === undefined) throw new Error("production child hook missing");
  await callback(
    {
      hook_event_name: "SubagentStart",
      agent_id: "child",
      agent_type: "general-purpose",
      session_id: fixture.state.id,
      transcript_path: fixture.nativePath,
      cwd: fixture.state.cwd,
    },
    undefined,
    { signal: new AbortController().signal },
  );
}

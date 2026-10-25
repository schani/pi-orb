import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
import {
  ClaudeOrbAgent,
  type ClaudeOrbAgentOptions,
  type ClaudeQuery,
  type NativeState,
} from "../claude/agent.ts";
import { ClaudeHistory, type HistoryFiles, nativeHistoryFiles } from "../claude/history.ts";

function latch() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
}

/**
 * Runtime journals live in memory: in-process restarts cannot lose them, and contended file
 * metadata I/O exceeded wall-clock test timeouts. `history.test.ts` covers production files. The
 * CLI-owned `.jsonl` transcripts stay real files, which `findNativeClaudeTranscript` lists.
 */
export function memoryHistoryFiles(): HistoryFiles {
  const journals = new Map<string, string>();
  return {
    read: (path) =>
      journals.get(path) ?? (path.endsWith(".jsonl") ? nativeHistoryFiles.read(path) : null),
    commit: (path, text) => {
      journals.set(path, text);
    },
    sync: () => undefined,
  };
}

/**
 * Only the SDK process and journal storage are fake: journal logic, normalization and admission
 * are production code.
 */
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
  readonly files = memoryHistoryFiles();
  readonly historyIO = { reads: 0, syncs: 0 };
  readonly history: ClaudeHistory;
  readonly agent: ClaudeOrbAgent;
  failCommit = false;
  failStateCommit = false;
  failSync = false;
  private readonly queryWaiters: ((query: ScheduledClaudeQuery) => void)[] = [];
  readonly accountReady: Promise<void>;
  constructor(
    accountReady: Promise<void> = Promise.resolve(),
    scheduling: Pick<ClaudeOrbAgentOptions, "yieldMessage"> = {
      yieldMessage: async () => undefined,
    },
  ) {
    this.accountReady = accountReady;
    mkdirSync(join(this.dir, "claude"));
    mkdirSync(this.nativeDir, { recursive: true });
    this.history = new ClaudeHistory(
      join(this.dir, "claude"),
      this.state.id,
      this.state.timestamp,
      {
        ...this.files,
        read: (path) => {
          if (path === this.nativePath) this.historyIO.reads++;
          return this.files.read(path);
        },
        commit: (path, text) => {
          if (this.failCommit) throw new Error("injected history commit failure");
          this.files.commit(path, text);
        },
        sync: (path) => {
          if (path === this.nativePath) this.historyIO.syncs++;
          if (this.failSync) throw new Error("injected native fsync failure");
          this.files.sync(path);
        },
      },
    );
    this.agent = new ClaudeOrbAgent({
      ...scheduling,
      orbId: "orb-a",
      repositoryUrl: "https://example.com/repo",
      workDir: this.dir,
      skillsDir: null,
      broker: null,
      incarnation: "0",
      files: {
        ...this.files,
        commit: (path, text) => {
          if (this.failStateCommit) throw new Error("injected state commit failure");
          this.files.commit(path, text);
        },
        sync: (path) => {
          if (this.failSync) throw new Error("injected workflow sync failure");
          this.files.sync(path);
        },
      },
      sdkFactory: (input, options) => {
        const query = new ScheduledClaudeQuery(input, options, this.queries.length === 0);
        this.queries.push(query);
        if (this.queries.length > 1) query.accountReady = this.accountReady;
        for (const waiter of this.queryWaiters.splice(0)) waiter(query);
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
  nextQuery(): Promise<ScheduledClaudeQuery> {
    return new Promise((resolve) => this.queryWaiters.push(resolve));
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
    const text = this.files.read(join(this.dir, "claude", "session.json"));
    if (text === null) throw new Error("fixture session journal not committed");
    return JSON.parse(text);
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
  accountReady: Promise<void> = Promise.resolve();
  interruptReceipt: Awaited<ReturnType<ClaudeQuery["interrupt"]>>;
  interrupt = async () => this.interruptReceipt;
  accountInfo = async () => {
    await this.accountReady;
    return {
      apiProvider: "firstParty" as const,
      tokenSource: "CLAUDE_CODE_OAUTH_TOKEN" as const,
    };
  };
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
    return this.emitUnscheduled(message);
  }
  emitUnscheduled(message: SDKMessage) {
    return this.enqueue(message);
  }
  /** Native stdout can run ahead of adapter consumption. The promise acknowledges consumption. */
  enqueue(message: SDKMessage): Promise<boolean> {
    if (this.outputEnded) return Promise.resolve(false);
    const consumed = latch();
    this.messages.push({ message, consumed });
    this.wake.release();
    return consumed.promise.then(() => true);
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

export const rootRequest = {
  type: "system",
  subtype: "status",
  status: "requesting",
  uuid: "11111111-1111-4111-8111-111111111111",
  session_id: "session",
} as unknown as SDKMessage;
export const rootResult = {
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 1,
  stop_reason: "end_turn",
  queued_turn_count: 0,
  result: "Completed.",
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

export async function childHook(
  task: SimulationTask,
  fixture: ComposedClaudeFixture,
  id = "child",
) {
  await task.checkpoint("native SubagentStart before inference");
  const callback = fixture.query.options.hooks?.SubagentStart?.[0]?.hooks[0];
  if (callback === undefined) throw new Error("production child hook missing");
  await callback(
    {
      hook_event_name: "SubagentStart",
      agent_id: id,
      agent_type: "general-purpose",
      session_id: fixture.state.id,
      transcript_path: fixture.nativePath,
      cwd: fixture.state.cwd,
    },
    undefined,
    { signal: new AbortController().signal },
  );
}

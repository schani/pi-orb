import { type ChildProcess, spawn } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  type ModelInfo,
  type Options,
  query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ServerFrame } from "@pi-orb/protocol";
import { NoSimulationTask, type SimulationTask } from "determined";
import { err, errAsync, ok, okAsync, Result } from "neverthrow";
import { afterEach, expect, it, vi } from "vitest";
import {
  background,
  childEdge,
  nativeHook,
  nativeHookResponse,
  ScheduledClaudeQuery,
} from "../testkit/claude-composed.ts";
import { runDst } from "../testkit/sim.ts";
import {
  ClaudeOrbAgent,
  type ClaudeOrbAgentOptions,
  type ClaudeQuery,
  type NativeState,
} from "./agent.ts";
import { ClaudeHistory, nativeHistoryFiles } from "./history.ts";
import * as mcpModule from "./mcp.ts";
import { qualifyClaudeRestart } from "./restore.ts";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
});
const failures = [
  "account",
  "auth",
  "models",
  "model_unavailable",
  "effort",
  "set_model",
  "flags",
  "persistence",
] as const;
type Failure = (typeof failures)[number];
const stages: Record<Failure, string> = {
  account: "account",
  auth: "account",
  models: "models",
  model_unavailable: "model",
  effort: "effort",
  set_model: "set_model",
  flags: "flags",
  persistence: "persistence",
};
const secret = "private-provider-error-not-for-history";

function fixture(autoDrain = true, factory?: ClaudeOrbAgentOptions["sdkFactory"], withMcp = false) {
  const dir = mkdtempSync(join(tmpdir(), "claude-initialization-"));
  const cwd = join(dir, "repo");
  const configDir = join(dir, "config");
  const historyDir = join(dir, "claude");
  const projectDir = join(configDir, "projects", "test-project");
  for (const path of [cwd, historyDir, projectDir]) mkdirSync(path, { recursive: true });
  const state: NativeState = {
    id: "8aceb374-0491-4c82-b761-2a21769a4a88",
    timestamp: "2026-10-04T00:00:00Z",
    cwd,
    deliveries: {},
  };
  const nativePath = join(projectDir, `${state.id}.jsonl`);
  writeFileSync(nativePath, "");
  let failure: Failure | undefined;
  let factories = 0;
  let closeRequests = 0;
  let flagCalls = 0;
  let modelCalls = 0;
  let settingsFailure: "set_model" | "flags" | "persistence" | undefined;
  let failHistory = false;
  let failClose = false;
  let scans = 0;
  let current = { exit: gate(), close: gate() };
  let stream: ScheduledClaudeQuery | undefined;
  const frames: ServerFrame[] = [];
  const models: ModelInfo[] = [
    { value: "opus", displayName: "Opus", description: "", supportedEffortLevels: ["low", "high"] },
  ];
  const history = new ClaudeHistory(historyDir, state.id, state.timestamp, {
    ...nativeHistoryFiles,
    sync(path) {
      scans++;
      if (failHistory) throw new Error(secret);
      nativeHistoryFiles.sync(path);
    },
  });
  const agent = new ClaudeOrbAgent({
    orbId: "o",
    repositoryUrl: "https://example.com/repo",
    workDir: dir,
    skillsDir: null,
    broker: withMcp ? { controlPlaneUrl: "http://unused.invalid", runtimeToken: "unused" } : null,
    sdkFactory:
      factory ??
      ((input: AsyncIterable<SDKUserMessage>, options: Options) => {
        factories++;
        current = { exit: gate(), close: gate() };
        const process = current;
        const output = new ScheduledClaudeQuery(input, options, false);
        stream = output;
        const sdk: ClaudeQuery = {
          async *[Symbol.asyncIterator]() {
            yield* output;
          },
          close() {
            output.close();
            if (failClose) throw new Error(secret);
          },
          async interrupt() {},
          async accountInfo() {
            if (failure === "account") throw new Error(secret);
            return {
              apiProvider: "firstParty",
              tokenSource: failure === "auth" ? "api-key" : "CLAUDE_CODE_OAUTH_TOKEN",
            };
          },
          async supportedModels() {
            if (failure === "models") throw new Error(secret);
            return failure === "model_unavailable" ? [] : models;
          },
          async setModel() {
            modelCalls++;
            if (failure === "set_model" || (settingsFailure === "set_model" && modelCalls === 3))
              throw new Error(secret);
          },
          async applyFlagSettings() {
            flagCalls++;
            if (failure === "flags" || (settingsFailure === "flags" && flagCalls === 3))
              throw new Error(secret);
            if (
              failure === "persistence" ||
              (settingsFailure === "persistence" && flagCalls === 3)
            ) {
              rmSync(join(historyDir, "session.json"), { force: true });
              mkdirSync(join(historyDir, "session.json"));
            }
          },
        };
        return ok({
          query: sdk,
          exited: process.exit.promise,
          stdoutEnded: output.stdoutEnded,
          requestShutdown: () => {
            closeRequests++;
            process.close.resolve();
            if (autoDrain) {
              process.exit.resolve();
              output.endOutput();
            }
            return ok(undefined);
          },
        });
      }),
  });
  agent.subscribe((frame) => frames.push(frame));
  cleanups.push(() => {
    current.exit.resolve();
    stream?.endOutput();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    agent,
    state,
    history,
    frames,
    nativePath,
    dir,
    failClose: () => {
      failClose = true;
    },
    attach: () => agent.attachSession(state, history, configDir, "commit"),
    fail(value: Failure) {
      failure = value;
      if (value === "effort") state.effort = "max";
    },
    failSettings(value: typeof settingsFailure) {
      settingsFailure = value;
    },
    closed: () => current.close.promise,
    exit: () => current.exit.resolve(),
    endOutput: () => stream?.endOutput(),
    emit: (task: SimulationTask, message: SDKMessage) => stream?.emit(task, message),
    async child() {
      const callback = stream?.options.hooks?.SubagentStart?.[0]?.hooks[0];
      expect(callback).toBeDefined();
      return callback?.(
        {
          hook_event_name: "SubagentStart",
          agent_id: "late-child",
          agent_type: "general-purpose",
          session_id: state.id,
          transcript_path: nativePath,
          cwd,
        },
        undefined,
        { signal: new AbortController().signal },
      );
    },
    journal: (): NativeState => JSON.parse(readFileSync(join(historyDir, "session.json"), "utf8")),
    factories: () => factories,
    closeRequests: () => closeRequests,
    flagCalls: () => flagCalls,
    scans: () => scans,
    failHistory: () => {
      failHistory = true;
    },
    append: () =>
      appendFileSync(
        nativePath,
        `${JSON.stringify({ type: "user", uuid: "late-native-record", message: { content: "retained before final drain" } })}\n`,
      ),
  };
}
function settings(f: ReturnType<typeof fixture>) {
  return f.frames
    .filter((frame) => frame.type === "runtime.event" && frame.event.type === "agent_settings")
    .at(-1);
}

it.each(failures)(
  "fails closed after %s initialization failure; partial query cannot accept settings or input",
  async (failure) => {
    const f = fixture();
    f.fail(failure);
    const initialized = await f.attach();
    expect(initialized.isErr()).toBe(true);
    expect(f.agent.getHealth()).toMatchObject({ status: "failed" });
    expect(f.agent.gateView().acceptingWork).toBe(false);
    expect(
      (await f.agent.changeSettings({ type: "set_thinking", thinkingLevel: "low" })).isErr(),
    ).toBe(true);
    expect(
      (await f.agent.submitMessage([{ type: "text", text: "must not run" }], "blocked")).isErr(),
    ).toBe(true);
    expect(f.factories()).toBe(1);
    expect(f.state.deliveries).toEqual({});
    const notice = f.history.view.find(
      (record) => record.type === "event" && record.eventType === "claude.initialization_failed",
    );
    expect(notice).toMatchObject({
      custom: { display: true },
      overflow: { stage: stages[failure] },
    });
    expect(
      JSON.stringify({ health: f.agent.getHealth(), frames: f.frames, records: f.history.view }),
    ).not.toContain(secret);
    expect((await f.agent.attachSession(f.state, f.history, "unused", "commit")).isErr()).toBe(
      true,
    );
    expect(f.factories()).toBe(1);
  },
);

it.each(failures)(
  "seals settings after %s failure while rotating a ready session",
  async (failure) => {
    const f = fixture();
    expect((await f.attach()).isOk()).toBe(true);
    f.fail(failure);
    expect(
      (await f.agent.changeSettings({ type: "set_thinking", thinkingLevel: "low" })).isErr(),
    ).toBe(true);
    expect(f.agent.getHealth()).toMatchObject({ status: "failed" });
    expect(f.agent.gateView()).toMatchObject({ configuring: false, acceptingWork: false });
    expect(settings(f)).toMatchObject({ event: { writable: false } });
    expect(f.closeRequests()).toBe(2);
    expect(
      (await f.agent.changeSettings({ type: "set_thinking", thinkingLevel: "high" })).isErr(),
    ).toBe(true);
    expect(f.factories()).toBe(2);
  },
);

it("rejects actual settings reuse of a partially initialized rotated query", async () => {
  const f = fixture();
  expect((await f.attach()).isOk()).toBe(true);
  f.fail("models");
  expect(
    (await f.agent.changeSettings({ type: "set_thinking", thinkingLevel: "low" })).isErr(),
  ).toBe(true);
  const reused = await f.agent.changeSettings({ type: "set_thinking", thinkingLevel: "high" });
  expect(reused.isErr()).toBe(true);
  expect(f.flagCalls()).toBe(1);
  expect(f.factories()).toBe(2);
  expect(settings(f)).toMatchObject({ event: { writable: false } });
});

it("holds failed settings initialization through native exit, stdout drain and final history publication", async () => {
  const f = fixture(false);
  const attached = f.attach();
  await f.closed();
  f.exit();
  f.endOutput();
  expect((await attached).isOk()).toBe(true);
  f.fail("models");
  let completed = false;
  const changed = Promise.resolve(
    f.agent.changeSettings({ type: "set_thinking", thinkingLevel: "low" }),
  ).then((result) => {
    completed = true;
    return result;
  });
  await f.closed();
  expect(completed).toBe(false);
  expect(f.agent.gateView()).toMatchObject({ configuring: true, acceptingWork: false });
  expect(settings(f)).toMatchObject({ event: { writable: false } });
  expect(
    (await f.agent.changeSettings({ type: "set_thinking", thinkingLevel: "high" })).isErr(),
  ).toBe(true);
  f.exit();
  await Promise.resolve();
  expect(completed).toBe(false);
  expect(f.agent.gateView().configuring).toBe(true);
  f.append();
  f.endOutput();
  expect((await changed).isErr()).toBe(true);
  expect(f.history.view.some((record) => record.id === "late-native-record")).toBe(true);
  expect(f.agent.gateView()).toMatchObject({ configuring: false, acceptingWork: false });
  expect(settings(f)).toMatchObject({ event: { writable: false } });
  expect(f.factories()).toBe(2);
  expect(
    (await f.agent.changeSettings({ type: "set_thinking", thinkingLevel: "high" })).isErr(),
  ).toBe(true);
  expect(f.factories()).toBe(2);
});

it("does not reopen settings when the final initialization history flush fails", async () => {
  const f = fixture(false);
  const attached = f.attach();
  await f.closed();
  f.exit();
  f.endOutput();
  expect((await attached).isOk()).toBe(true);
  f.fail("set_model");
  const changed = f.agent.changeSettings({ type: "set_thinking", thinkingLevel: "low" });
  await f.closed();
  const scans = f.scans();
  f.failHistory();
  f.exit();
  f.endOutput();
  expect((await changed).isErr()).toBe(true);
  expect(f.scans()).toBeGreaterThan(scans);
  expect(f.agent.getHealth()).toMatchObject({
    status: "failed",
    error: { code: "history_unavailable" },
  });
  expect(settings(f)).toMatchObject({ event: { writable: false } });
  expect((await f.agent.submitMessage([{ type: "text", text: "blocked" }], "op")).isErr()).toBe(
    true,
  );
});

it.each(["set_model", "flags", "persistence"] as const)(
  "closes a %s settings mutation failure rather than retaining its native query",
  async (failure) => {
    const f = fixture();
    expect((await f.attach()).isOk()).toBe(true);
    f.failSettings(failure);
    expect(
      (
        await f.agent.changeSettings({
          type: "set_model",
          model: { provider: "claude", id: "opus" },
        })
      ).isErr(),
    ).toBe(true);
    expect(f.closeRequests()).toBe(2);
    expect(settings(f)).toMatchObject({ event: { writable: false } });
  },
);

it.each(["set_model", "flags", "persistence"] as const)(
  "drains a %s settings mutation error before releasing configuration ownership",
  async (failure) => {
    const f = fixture(false);
    const attached = f.attach();
    await f.closed();
    f.exit();
    f.endOutput();
    expect((await attached).isOk()).toBe(true);
    f.failSettings(failure);
    let completed = false;
    const changed = Promise.resolve(
      f.agent.changeSettings({ type: "set_model", model: { provider: "claude", id: "opus" } }),
    ).then((result) => {
      completed = true;
      return result;
    });
    await f.closed();
    expect(completed).toBe(false);
    expect(f.agent.gateView()).toMatchObject({ configuring: true, acceptingWork: false });
    expect(settings(f)).toMatchObject({ event: { writable: false } });
    f.exit();
    await Promise.resolve();
    expect(completed).toBe(false);
    f.endOutput();
    expect((await changed).isErr()).toBe(true);
    expect(f.agent.getHealth()).toMatchObject({ status: "failed" });
    expect(f.agent.gateView()).toMatchObject({ configuring: false, acceptingWork: false });
    expect(settings(f)).toMatchObject({ event: { writable: false } });
    expect(
      JSON.stringify({ health: f.agent.getHealth(), frames: f.frames, records: f.history.view }),
    ).not.toContain(secret);
  },
);

const metadataKinds = ["attach", "settings"] as const;
const lateKinds = ["requesting", "assistant", "child", "task", "background", "hook"] as const;
type LateKind = (typeof lateKinds)[number];
async function lateWork(f: ReturnType<typeof fixture>, kind: LateKind, task: SimulationTask) {
  if (kind === "child") {
    await task.checkpoint("late native SubagentStart during metadata close");
    expect(await f.child()).toEqual({});
    return;
  }
  const message =
    kind === "hook"
      ? nativeHook("late-hook", "Setup")
      : kind === "background"
        ? background([{ task_id: "late-task", description: "native background work" }])
        : kind === "task"
          ? childEdge("task_started")
          : kind === "requesting"
            ? ({ type: "system", subtype: "status", status: "requesting" } as SDKMessage)
            : ({
                type: "assistant",
                uuid: "late-assistant",
                parent_tool_use_id: null,
                message: { content: [] },
              } as unknown as SDKMessage);
  expect(await f.emit(task, message)).toBe(true);
}
function assertMetadataFailed(f: ReturnType<typeof fixture>, kind: LateKind) {
  expect(f.agent.getHealth()).toMatchObject({ status: "failed" });
  expect(f.agent.gateView()).toMatchObject({ acceptingWork: false });
  expect(settings(f)).toMatchObject({ event: { writable: false } });
  expect(f.agent.prepareIdleStop().isErr()).toBe(true);
  expect(f.history.view.some((record) => record.id === "late-native-record")).toBe(true);
  expect(
    f.frames.some(
      (frame) => frame.type === "history.record" && frame.record.id === "late-native-record",
    ),
  ).toBe(true);
  const notice = f.history.view.find(
    (record) => record.type === "event" && record.eventType === "claude.metadata_failed",
  );
  expect(notice).toMatchObject({
    custom: { display: true },
    overflow: {
      reason: kind === "requesting" || kind === "assistant" ? "root_work" : "owned_work",
    },
  });
  if (kind === "child" || kind === "task" || kind === "background") {
    const journal = f.journal();
    expect(qualifyClaudeRestart(journal, f.history.view, journal.guardLifetime ?? "").isErr()).toBe(
      true,
    );
    expect(
      journal[
        kind === "child" ? "ownedChildren" : kind === "task" ? "ownedTasks" : "ownedBackgroundTasks"
      ],
    ).not.toEqual({});
  }
}
it.each(metadataKinds)(
  "%s metadata fails closed for late root and persistent native work",
  async (metadata) => {
    for (const kind of lateKinds) {
      const f = fixture(false);
      if (metadata === "settings") {
        const attached = f.attach();
        await f.closed();
        f.exit();
        f.endOutput();
        expect((await attached).isOk()).toBe(true);
      }
      let completed = false;
      const result = Promise.resolve(
        metadata === "attach"
          ? f.attach()
          : f.agent.changeSettings({ type: "set_thinking", thinkingLevel: "low" }),
      ).then((value) => {
        completed = true;
        return value;
      });
      await f.closed();
      await lateWork(f, kind, new NoSimulationTask("late-metadata", false));
      expect(completed).toBe(false);
      expect(
        f.agent.prepareIdleStop().isOk() ? f.agent.prepareIdleStop()._unsafeUnwrap() : false,
      ).toBe(false);
      f.exit();
      await Promise.resolve();
      expect(completed).toBe(false);
      f.append();
      f.endOutput();
      expect((await result).isErr(), `${metadata}: ${kind}`).toBe(true);
      assertMetadataFailed(f, kind);
      expect(
        (await f.agent.changeSettings({ type: "set_thinking", thinkingLevel: "high" })).isErr(),
      ).toBe(true);
      expect(
        (await f.agent.submitMessage([{ type: "text", text: "blocked" }], "blocked")).isErr(),
      ).toBe(true);
    }
  },
);
it.each(metadataKinds)(
  "%s native hook drain permits paired Setup and SessionStart hooks before final EOF",
  async (metadata) => {
    const f = fixture(false);
    if (metadata === "settings") {
      const attached = f.attach();
      await f.closed();
      f.exit();
      f.endOutput();
      expect((await attached).isOk()).toBe(true);
    }
    const result =
      metadata === "attach"
        ? f.attach()
        : f.agent.changeSettings({ type: "set_thinking", thinkingLevel: "low" });
    const task = new NoSimulationTask("paired-native-hooks", false);
    const setup = nativeHook("setup", "Setup");
    const resume = nativeHook("resume", "SessionStart");
    expect(await f.emit(task, setup)).toBe(true);
    expect(await f.emit(task, resume)).toBe(true);
    await f.closed();
    f.exit();
    expect(f.agent.gateView()).toMatchObject({ configuring: true, activity: "busy" });
    expect(await f.emit(task, nativeHookResponse(resume))).toBe(true);
    expect(await f.emit(task, nativeHookResponse(setup))).toBe(true);
    f.append();
    f.endOutput();
    expect((await result).isOk()).toBe(true);
    expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
    expect(settings(f)).toMatchObject({ event: { writable: true } });
    expect(f.history.view.some((record) => record.id === "late-native-record")).toBe(true);
    expect(JSON.stringify({ frames: f.frames, records: f.history.view })).not.toContain(
      "private-hook",
    );
  },
);
it.each(metadataKinds)(
  "%s native hook drain rejects an unmatched start after process exit and final stdout/history drain",
  async (metadata) => {
    const f = fixture(false);
    if (metadata === "settings") {
      const attached = f.attach();
      await f.closed();
      f.exit();
      f.endOutput();
      expect((await attached).isOk()).toBe(true);
    }
    const result =
      metadata === "attach"
        ? f.attach()
        : f.agent.changeSettings({ type: "set_thinking", thinkingLevel: "low" });
    await f.closed();
    f.exit();
    const task = new NoSimulationTask("unmatched-native-hook", false);
    expect(await f.emit(task, nativeHook("unmatched", "Setup"))).toBe(true);
    expect(await f.emit(task, nativeHookResponse(nativeHook("other", "Setup")))).toBe(true);
    f.append();
    f.endOutput();
    expect((await result).isErr()).toBe(true);
    await f.agent.waitForStream();
    assertMetadataFailed(f, "hook");
    expect(f.agent.gateView().activity).toBe("busy");
    expect(
      JSON.stringify({ health: f.agent.getHealth(), frames: f.frames, records: f.history.view }),
    ).not.toContain("private-hook");
  },
);
it.each(metadataKinds)(
  "%s metadata remains sealed until successful final history drain",
  async (metadata) => {
    const f = fixture(false);
    if (metadata === "settings") {
      const attached = f.attach();
      await f.closed();
      f.exit();
      f.endOutput();
      expect((await attached).isOk()).toBe(true);
    }
    const result =
      metadata === "attach"
        ? f.attach()
        : f.agent.changeSettings({ type: "set_thinking", thinkingLevel: "low" });
    await f.closed();
    expect(settings(f)).toMatchObject({ event: { writable: false } });
    expect(f.agent.gateView().configuring).toBe(true);
    f.exit();
    f.append();
    f.endOutput();
    expect((await result).isOk()).toBe(true);
    expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
    expect(settings(f)).toMatchObject({ event: { writable: true } });
    expect(f.history.view.some((record) => record.id === "late-native-record")).toBe(true);
  },
);
it.each(metadataKinds)(
  "%s metadata final durable history failure stays sealed",
  async (metadata) => {
    const f = fixture(false);
    if (metadata === "settings") {
      const attached = f.attach();
      await f.closed();
      f.exit();
      f.endOutput();
      expect((await attached).isOk()).toBe(true);
    }
    const result =
      metadata === "attach"
        ? f.attach()
        : f.agent.changeSettings({ type: "set_thinking", thinkingLevel: "low" });
    await f.closed();
    f.append();
    f.failHistory();
    f.exit();
    f.endOutput();
    expect((await result).isErr()).toBe(true);
    expect(f.agent.getHealth()).toMatchObject({
      status: "failed",
      error: { code: "history_unavailable" },
    });
    expect(settings(f)).toMatchObject({ event: { writable: false } });
    expect(f.agent.prepareIdleStop().isErr()).toBe(true);
  },
);
it.each(["ownedChildren", "ownedTasks", "ownedBackgroundTasks", "pendingHandoffs"] as const)(
  "persisted %s guards block readiness and admission without an operation",
  async (guard) => {
    const f = fixture();
    expect((await f.attach()).isOk()).toBe(true);
    f.state[guard] = { retained: "retained native work" };
    expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "busy" });
    expect(f.agent.gateView().activity).toBe("busy");
    expect(f.agent.snapshot()._unsafeUnwrap().activity).toBe("busy");
    expect(f.agent.prepareIdleStop()._unsafeUnwrap()).toBe(false);
    expect(
      (await f.agent.changeSettings({ type: "set_thinking", thinkingLevel: "low" })).isErr(),
    ).toBe(true);
    expect(
      (await f.agent.submitMessage([{ type: "text", text: "blocked" }], "blocked")).isErr(),
    ).toBe(true);
  },
);
it("native child guards without an operation still block readiness and admission", async () => {
  const f = fixture();
  expect((await f.attach()).isOk()).toBe(true);
  expect(await f.child()).toEqual({});
  expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "busy" });
  expect(f.agent.gateView().activity).toBe("busy");
  expect(f.agent.snapshot()._unsafeUnwrap().activity).toBe("busy");
  expect(f.agent.prepareIdleStop()._unsafeUnwrap()).toBe(false);
  expect(
    (await f.agent.changeSettings({ type: "set_thinking", thinkingLevel: "low" })).isErr(),
  ).toBe(true);
  expect(
    (await f.agent.submitMessage([{ type: "text", text: "blocked" }], "blocked")).isErr(),
  ).toBe(true);
});
it.each(metadataKinds)(
  "%s composed DST retains late ownership across independent exit and EOF",
  async (metadata) => {
    await runDst({ name: `claude-late-metadata-${metadata}`, iterations: 20 }, async (sim) => {
      const f = fixture(false);
      if (metadata === "settings") {
        const attached = f.attach();
        await f.closed();
        f.exit();
        f.endOutput();
        expect((await attached).isOk()).toBe(true);
      }
      let closing = false;
      const result = await sim.runTasks([
        {
          name: "metadata-owner",
          f: async (task) => {
            const query =
              metadata === "attach"
                ? f.attach()
                : f.agent.changeSettings({ type: "set_thinking", thinkingLevel: "low" });
            await f.closed();
            await lateWork(f, "child", task);
            await lateWork(f, "background", task);
            closing = true;
            expect((await query).isErr()).toBe(true);
            assertMetadataFailed(f, "child");
          },
        },
        {
          name: "process-exit",
          f: async (task) => {
            while (!closing) await task.sleep(1, "wait for late work admission");
            await task.checkpoint("independent metadata process exit");
            f.exit();
          },
        },
        {
          name: "native-history-and-EOF",
          f: async (task) => {
            while (!closing) await task.sleep(1, "wait for late work admission");
            await task.checkpoint("final metadata native history before EOF");
            f.append();
            f.endOutput();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  },
);

const syntheticCli = String.raw`
import json, os, sys

def send(value):
    print(json.dumps(value), flush=True)

hook = None
for line in sys.stdin:
    value = json.loads(line)
    if value['type'] == 'control_request':
        request = value['request']
        response = {}
        if request['subtype'] == 'initialize':
            hook = request.get('hooks', {}).get('SubagentStart', [{}])[0].get('hookCallbackIds', [None])[0]
            response = {
                'account': {'apiProvider': 'firstParty', 'tokenSource': 'CLAUDE_CODE_OAUTH_TOKEN'},
                'models': [{'value': 'opus', 'displayName': 'Opus', 'description': '', 'supportedEffortLevels': ['low', 'high']}],
            }
        send({'type': 'control_response', 'response': {'subtype': 'success', 'request_id': value['request_id'], 'response': response}})
    elif value['type'] == 'user':
        with open(os.environ['OWNED_NATIVE_PATH'], 'a') as native:
            native.write(json.dumps({'type': 'user', 'uuid': value['uuid'], 'message': value['message']}) + '\n')
        send({'type': 'result', 'subtype': 'success', 'is_error': False, 'num_turns': 1, 'result': 'done'})
if os.environ['HOLD_TAIL'] == '1' and os.fork() == 0:
    command = os.read(3, 65536).decode().strip()
    if command:
        with open(os.environ['OWNED_NATIVE_PATH'], 'a') as native:
            native.write(json.dumps({'type': 'user', 'uuid': 'late-native-record', 'message': {'content': 'final native history'}}) + '\n')
        if command == 'root':
            send({'type': 'system', 'subtype': 'status', 'status': 'requesting'})
        if command == 'child':
            send({'type': 'control_request', 'request_id': 'late-hook', 'request': {'subtype': 'hook_callback', 'callback_id': hook, 'input': {'hook_event_name': 'SubagentStart', 'agent_id': 'late-child', 'agent_type': 'general-purpose'}}})
            send({'type': 'system', 'subtype': 'background_tasks_changed', 'tasks': [{'task_id': 'late-task', 'description': 'native background work'}]})
        if command in ('hook', 'hook-paired'):
            send({'type': 'system', 'subtype': 'hook_started', 'hook_id': 'late-hook', 'hook_name': 'private-hook-command', 'hook_event': 'Setup', 'uuid': '11111111-1111-4111-8111-111111111111', 'session_id': 'session'})
            if command == 'hook-paired':
                send({'type': 'system', 'subtype': 'hook_response', 'hook_id': 'late-hook', 'hook_name': 'private-hook-command', 'hook_event': 'Setup', 'uuid': '22222222-2222-4222-8222-222222222222', 'session_id': 'session', 'outcome': 'success', 'exit_code': 0, 'stdout': 'private-hook-output', 'stderr': '', 'output': 'private-hook-output'})
    os._exit(0)
`;
function pinnedFixture(holdInitial = false) {
  let held = holdInitial;
  let launched = gate();
  let current:
    | {
        child: ChildProcess;
        sdk: ReturnType<typeof query>;
        exited: Promise<void>;
        stdoutEnded: Promise<Result<void, { message: string }>>;
        closes: number;
      }
    | undefined;
  const children: ChildProcess[] = [];
  let nativePath = "";
  const f = fixture(false, (input, options) => {
    const started = gate();
    launched = started;
    const exit = gate();
    const eof = gate();
    let eofResult: Result<void, { message: string }> = ok(undefined);
    let child: ChildProcess | undefined;
    const sdk = query({
      prompt: input,
      options: {
        ...options,
        env: {
          ...options.env,
          NATIVE_CONTRACT_PORT: "0",
          HOLD_TAIL: held ? "1" : "0",
          OWNED_NATIVE_PATH: nativePath,
        },
        spawnClaudeCodeProcess: (spawnOptions) => {
          child = spawn(
            "/usr/bin/python3",
            [
              fileURLToPath(
                new URL(
                  "../../../../scripts/claude-sdk-contract/network-guard.py",
                  import.meta.url,
                ),
              ),
              "/usr/bin/python3",
              "-c",
              syntheticCli,
            ],
            {
              cwd: spawnOptions.cwd,
              env: spawnOptions.env,
              stdio: ["pipe", "pipe", "pipe", "pipe"],
              detached: true,
            },
          );
          children.push(child);
          child.once("exit", exit.resolve);
          child.once("error", () => {
            eofResult = err({ message: "Synthetic native process failed." });
            exit.resolve();
            eof.resolve();
          });
          child.stdout?.once("end", eof.resolve);
          child.stdout?.once("error", () => {
            eofResult = err({ message: "Synthetic stdout failed." });
            eof.resolve();
          });
          child.stderr?.resume();
          started.resolve();
          return child as ReturnType<typeof spawn> & {
            stdin: NonNullable<ChildProcess["stdin"]>;
            stdout: NonNullable<ChildProcess["stdout"]>;
            stderr: NonNullable<ChildProcess["stderr"]>;
          };
        },
      },
    });
    const stdoutEnded = eof.promise.then(() => eofResult);
    let closes = 0;
    const wrapped: ClaudeQuery = {
      [Symbol.asyncIterator]: () => sdk[Symbol.asyncIterator](),
      accountInfo: () => sdk.accountInfo(),
      supportedModels: () => sdk.supportedModels(),
      setModel: (model) => sdk.setModel(model),
      applyFlagSettings: (settings) => sdk.applyFlagSettings(settings),
      interrupt: () => sdk.interrupt(),
      close: () => {
        closes++;
        sdk.close();
      },
    };
    void started.promise.then(() => {
      if (child !== undefined)
        current = {
          child,
          sdk,
          exited: exit.promise,
          stdoutEnded,
          get closes() {
            return closes;
          },
        };
    });
    return ok({
      query: wrapped,
      exited: exit.promise,
      stdoutEnded,
      requestShutdown: () => ok(undefined),
    });
  });
  nativePath = f.nativePath;
  cleanups.push(() => {
    for (const child of children) {
      const tail = child.stdio[3] as Writable | null;
      if (tail !== null && !tail.writableEnded && !tail.destroyed) tail.end("\n");
      Result.fromThrowable(
        () => {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        },
        () => undefined,
      )();
    }
  });
  return {
    ...f,
    hold: () => {
      held = true;
    },
    async process() {
      await launched.promise;
      expect(current).toBeDefined();
      if (current === undefined) throw new Error("Synthetic process was not launched.");
      return current;
    },
    release: (kind: "root" | "child" | "clean" | "hook" | "hook-paired") => {
      expect(current).toBeDefined();
      if (current === undefined) throw new Error("Synthetic process was not launched.");
      (current.child.stdio[3] as Writable).end(`${kind}\n`);
    },
  };
}
const pinnedIt = it.skipIf(process.platform !== "linux" || process.arch !== "x64");
pinnedIt.each([
  ["attach", "root"],
  ["attach", "child"],
  ["attach", "clean"],
  ["settings", "root"],
  ["settings", "child"],
  ["settings", "clean"],
  ["operation", "child"],
  ["operation", "root"],
  ["operation", "clean"],
  ["attach", "hook"],
  ["attach", "hook-paired"],
  ["settings", "hook"],
  ["settings", "hook-paired"],
  ["operation", "hook"],
  ["operation", "hook-paired"],
] as const)(
  "pinned SDK %s/%s keeps native reader and hooks alive until actual stdout EOF",
  async (kind, tail) => {
    const f = pinnedFixture(kind === "attach");
    if (kind !== "attach") {
      expect((await f.attach()).isOk()).toBe(true);
      expect((await f.process()).closes).toBe(1);
      f.hold();
    }
    const result =
      kind === "attach"
        ? f.attach()
        : kind === "settings"
          ? f.agent.changeSettings({ type: "set_thinking", thinkingLevel: "low" })
          : f.agent.submitMessage([{ type: "text", text: "synthetic input" }], "native-operation");
    if (kind === "operation") expect((await result).isOk()).toBe(true);
    const native = await f.process();
    await native.exited;
    expect(native.closes).toBe(0);
    let ended = false;
    void native.stdoutEnded.then(() => {
      ended = true;
    });
    await Promise.resolve();
    expect(ended).toBe(false);
    expect(f.agent.gateView()).toMatchObject({ activity: "busy" });
    f.release(tail);
    if (kind === "operation") await f.agent.closeExtensions();
    else expect((await result).isErr()).toBe(tail !== "clean" && tail !== "hook-paired");
    expect(native.closes).toBe(1);
    expect((await native.stdoutEnded).isOk()).toBe(true);
    expect(f.history.view.some((record) => record.id === "late-native-record")).toBe(true);
    if (tail === "clean" || tail === "hook-paired") {
      expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
      expect(settings(f)).toMatchObject({ event: { writable: true } });
    } else {
      expect(f.agent.getHealth()).toMatchObject({ status: "failed" });
      expect(f.agent.prepareIdleStop().isErr()).toBe(true);
    }
    if (tail === "hook") {
      expect(
        f.history.view.find(
          (record) =>
            record.type === "event" &&
            record.eventType ===
              (kind === "operation" ? "claude.rotation_failed" : "claude.metadata_failed"),
        ),
      ).toMatchObject({
        custom: { display: true },
        overflow: { reason: "owned_work", pendingHooks: 1 },
      });
      expect(f.agent.gateView()).toMatchObject({ activity: "busy", acceptingWork: false });
      expect(
        f.history.view.some(
          (record) => record.type === "event" && record.eventType === "claude.operation_finished",
        ),
      ).toBe(false);
    }
    expect(JSON.stringify({ frames: f.frames, records: f.history.view })).not.toContain(
      "private-hook",
    );
    if (tail === "child") {
      expect(f.journal().ownedChildren).toEqual({ "late-child": "Native Claude agent" });
      expect(f.journal().ownedBackgroundTasks).toEqual({ "late-task": "native background work" });
      expect(f.agent.gateView().activity).toBe("busy");
    }
  },
  10_000,
);
pinnedIt(
  "pinned SDK close ends public iteration before the owned transport stdout reaches EOF",
  async () => {
    const f = pinnedFixture(true);
    const attached = f.attach();
    const native = await f.process();
    await native.exited;
    native.sdk.close();
    await f.agent.waitForStream();
    let ended = false;
    void native.stdoutEnded.then(() => {
      ended = true;
    });
    await Promise.resolve();
    expect(ended).toBe(false);
    f.release("clean");
    expect((await attached).isOk()).toBe(true);
  },
);
it("late root work after an operation result keeps the drained runtime failed and owned", async () => {
  const f = fixture(false);
  const attached = f.attach();
  await f.closed();
  f.exit();
  f.endOutput();
  expect((await attached).isOk()).toBe(true);
  expect((await f.agent.submitMessage([{ type: "text", text: "input" }], "root-race")).isOk()).toBe(
    true,
  );
  const delivery = Object.values(f.state.deliveries)[0];
  appendFileSync(
    f.nativePath,
    `${JSON.stringify({ type: "user", uuid: delivery?.uuid, message: { content: "input" } })}\n`,
  );
  const task = new NoSimulationTask("root-race", false);
  expect(
    await f.emit(task, { type: "result", subtype: "success", is_error: false } as SDKMessage),
  ).toBe(true);
  await f.closed();
  await lateWork(f, "requesting", task);
  f.exit();
  f.endOutput();
  await f.agent.closeExtensions();
  expect(f.agent.getHealth()).toMatchObject({ status: "failed" });
  expect(f.agent.gateView().activity).toBe("busy");
  expect(
    f.history.view.find(
      (record) => record.type === "event" && record.eventType === "claude.rotation_failed",
    ),
  ).toBeDefined();
});
it("abort returns Err when drained SDK cleanup fails", async () => {
  const f = fixture();
  expect((await f.attach()).isOk()).toBe(true);
  expect(
    (await f.agent.submitMessage([{ type: "text", text: "input" }], "abort-cleanup")).isOk(),
  ).toBe(true);
  f.failClose();
  expect((await f.agent.abortOperation()).isErr()).toBe(true);
  expect(f.agent.getHealth()).toMatchObject({ status: "failed" });
  expect(f.agent.gateView().activity).toBe("busy");
});
it.each(["sdk", "mcp"] as const)(
  "%s cleanup failure never publishes a completed operation or releases ownership",
  async (kind) => {
    let failMcp = false;
    vi.spyOn(mcpModule, "createClaudeMcp").mockImplementation(() =>
      ok({
        mcpServers: {},
        close: () =>
          failMcp
            ? errAsync({ type: "mcp_error", code: "unavailable", message: secret })
            : okAsync(undefined),
      }),
    );
    const f = fixture(true, undefined, kind === "mcp");
    expect((await f.attach()).isOk()).toBe(true);
    expect(
      (await f.agent.submitMessage([{ type: "text", text: "owned input" }], "cleanup-op")).isOk(),
    ).toBe(true);
    const delivery = Object.values(f.state.deliveries)[0];
    expect(delivery).toBeDefined();
    appendFileSync(
      f.nativePath,
      `${JSON.stringify({ type: "user", uuid: delivery?.uuid, message: { content: "owned input" } })}\n`,
    );
    if (kind === "sdk") f.failClose();
    else failMcp = true;
    expect(
      await f.emit(new NoSimulationTask("cleanup", false), {
        type: "result",
        subtype: "success",
        is_error: false,
      } as SDKMessage),
    ).toBe(true);
    await f.agent.closeExtensions();
    expect(f.agent.getHealth()).toMatchObject({
      status: "failed",
      error: { code: kind === "sdk" ? "claude_shutdown_failed" : "claude_mcp_cleanup_failed" },
    });
    expect(f.agent.gateView()).toMatchObject({ activity: "busy", acceptingWork: false });
    expect(
      f.history.view.some(
        (record) => record.type === "event" && record.eventType === "claude.operation_finished",
      ),
    ).toBe(false);
    expect(
      f.history.view.find(
        (record) => record.type === "event" && record.eventType === "claude.cleanup_failed",
      ),
    ).toMatchObject({ custom: { display: true } });
    expect(JSON.stringify({ frames: f.frames, records: f.history.view })).not.toContain(secret);
    expect(
      (await f.agent.changeSettings({ type: "set_thinking", thinkingLevel: "low" })).isErr(),
    ).toBe(true);
  },
);

it("retains uncertain child ownership after a failed initialization has drained", async () => {
  const f = fixture();
  f.state.ownedChildren = { child: "retained native child" };
  f.fail("flags");
  expect((await f.attach()).isErr()).toBe(true);
  expect(f.state.ownedChildren).toEqual({ child: "retained native child" });
  expect(f.agent.gateView()).toMatchObject({ activity: "busy", acceptingWork: false });
  expect(f.agent.prepareIdleStop().isErr()).toBe(true);
});

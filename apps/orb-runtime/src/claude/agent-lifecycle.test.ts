import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AccountInfo,
  ModelInfo,
  Options,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { projectDisplayRecord, type ServerFrame } from "@pi-orb/protocol";
import { err, ok } from "neverthrow";
import { afterEach, expect, it, vi } from "vitest";
import {
  nativeHook,
  nativeHookResponse,
  rootRequest,
  rootResult,
  ScheduledClaudeQuery,
} from "../testkit/claude-composed.ts";
import {
  ClaudeOrbAgent,
  type ClaudeOrbAgentOptions,
  type ClaudeQuery,
  type NativeState,
} from "./agent.ts";
import { ClaudeHistory, nativeHistoryFiles } from "./history.ts";
import { qualifyClaudeRestart } from "./restore.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(
  account: AccountInfo = {
    apiProvider: "firstParty",
    apiKeySource: "none",
    tokenSource: "CLAUDE_CODE_OAUTH_TOKEN",
  },
  holdMetadata = false,
  modelUsage?: ClaudeOrbAgentOptions["modelUsage"],
) {
  const dir = mkdtempSync(join(tmpdir(), "claude-lifecycle-"));
  dirs.push(dir);
  const configDir = join(dir, "config");
  const state: NativeState = {
    id: "8aceb374-0491-4c82-b761-2a21769a4a88",
    timestamp: "2026-10-04T00:00:00Z",
    cwd: "/repo",
    deliveries: {},
  };
  mkdirSync(join(dir, "claude"));
  mkdirSync(join(configDir, "projects", "-repo"), { recursive: true });
  const nativePath = join(configDir, "projects", "-repo", `${state.id}.jsonl`);
  const frames: ServerFrame[] = [];
  let sdk: ScheduledClaudeQuery;
  let options: Options | null = null;
  const queryOptions: Options[] = [];
  const selectedModels: string[] = [];
  const flagSettings: Record<string, unknown>[] = [];
  let models: ModelInfo[] = [
    {
      value: "default",
      displayName: "Default (Opus)",
      description: "",
      supportedEffortLevels: ["low", "high"],
    },
    ...["sonnet", "fable", "opus"].map((value) => ({
      value,
      displayName: value,
      description: "",
      supportedEffortLevels: ["low", "high"] as ("low" | "high")[],
    })),
    { value: "haiku", displayName: "Haiku", description: "", supportedEffortLevels: [] },
  ];
  let prompt: AsyncIterable<SDKUserMessage> | null = null;
  let failHistory = false;
  let failStartup = false;
  let closeRequests = 0;
  const closeWaiters: { count: number; resolve: () => void }[] = [];
  let accountBarrier: Promise<void> | null = null;
  let releaseAccount: (() => void) | undefined;
  const requestShutdown = () => {
    closeRequests++;
    for (const waiter of closeWaiters.filter((waiter) => waiter.count <= closeRequests))
      waiter.resolve();
    if (!holdMetadata && Object.keys(state.deliveries).length === 0) {
      sdk.exit();
      sdk.endOutput();
    }
    return ok(undefined);
  };
  const history = new ClaudeHistory(join(dir, "claude"), state.id, state.timestamp, {
    ...nativeHistoryFiles,
    sync: (path) => {
      if (failHistory) throw new Error("injected fsync failure");
      nativeHistoryFiles.sync(path);
    },
  });
  const agent = new ClaudeOrbAgent({
    orbId: "o",
    repositoryUrl: "https://example.com/repo",
    workDir: dir,
    skillsDir: null,
    broker: null,
    ...(modelUsage === undefined ? {} : { modelUsage }),
    sdkFactory: (input, opts) => {
      if (failStartup) return err({ message: "injected startup failure" });
      sdk = new ScheduledClaudeQuery(input, opts, false);
      Object.assign(sdk, {
        interrupt: async () => undefined,
        accountInfo: async () => {
          await accountBarrier;
          return account;
        },
        supportedModels: async () => models,
        setModel: async (model) => {
          if (model !== undefined) selectedModels.push(model);
        },
        applyFlagSettings: async (settings) => {
          flagSettings.push(settings);
        },
      } satisfies Pick<
        ClaudeQuery,
        "interrupt" | "accountInfo" | "supportedModels" | "setModel" | "applyFlagSettings"
      >);
      options = opts;
      queryOptions.push(opts);
      prompt = input;
      return ok({
        query: sdk,
        exited: sdk.processExit.promise,
        stdoutEnded: sdk.stdoutEnded,
        requestShutdown,
      });
    },
  });
  agent.subscribe((frame) => frames.push(frame));
  return {
    agent,
    dir,
    state,
    history,
    frames,
    options: () => options,
    queryOptions,
    selectedModels,
    flagSettings,
    models: (value: ModelInfo[]) => {
      models = value;
    },
    closeRequests: () => closeRequests,
    awaitCloseRequest: (count: number) =>
      closeRequests >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => closeWaiters.push({ count, resolve })),
    prompt: () => prompt,
    attach: (notifyRestart = false) =>
      agent.attachSession(
        state,
        history,
        configDir,
        "commit",
        ...(notifyRestart ? ([null] as const) : []),
      ),
    nativePath,
    emit: (message: SDKMessage) => sdk.emitUnscheduled(message),
    exit: () => {
      sdk.exit();
      sdk.endOutput();
    },
    exitWithoutOutput: () => sdk.exit(),
    endOutput: () => sdk.endOutput(),
    persist: (entry: object) => appendFileSync(nativePath, `${JSON.stringify(entry)}\n`),
    failHistory: () => {
      failHistory = true;
    },
    failNextQuery: () => {
      failStartup = true;
    },
    blockAccount: () => {
      accountBarrier = new Promise<void>((resolve) => {
        releaseAccount = resolve;
      });
    },
    releaseAccount: () => releaseAccount?.(),
  };
}
it("records successful subscription diagnostics outside conversation history", async () => {
  const f = fixture();
  await f.attach();
  expect(f.state).toMatchObject({
    authentication: { source: "CLAUDE_CODE_OAUTH_TOKEN", generation: 0 },
  });
  expect(
    f.history.view.some((record) => record.type === "event" && record.eventType === "claude.auth"),
  ).toBe(false);
});

it("records each model call as a hidden replicated history event", async () => {
  const f = fixture();
  await f.attach();
  const call = {
    outcome: "ok" as const,
    at: "2026-10-14T00:00:00.500Z",
    model: "claude-opus-5-5",
    querySource: "sdk",
    input: 3,
    output: 200,
    cacheRead: 40_000,
    cacheWrite: 1_500,
    costUsd: 0.042,
  };
  f.agent.recordModelCall(call);
  f.agent.recordModelCall({ ...call, querySource: "compact" });
  const events = f.history.view.filter(
    (record) => record.type === "event" && record.eventType === "claude.model_call",
  );
  expect(events.map((record) => record.overflow)).toEqual([
    call,
    { ...call, querySource: "compact" },
  ]);
  expect(
    events.every((record) => record.type === "event" && record.custom?.display === false),
  ).toBe(true);
  f.exit();
});

it("points Claude Code's OpenTelemetry log export at the model usage receiver", async () => {
  const f = fixture(
    undefined,
    false,
    ok({ endpoint: "http://127.0.0.1:1/v1/logs", token: "t", close: async () => undefined }),
  );
  await f.attach();
  expect(f.options()?.env).toMatchObject({
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:1/v1/logs",
    OTEL_EXPORTER_OTLP_LOGS_HEADERS: "authorization=Bearer t",
  });
  f.exit();
});

it("runs Claude without export and records why when the receiver could not listen", async () => {
  const f = fixture(
    undefined,
    false,
    err({ code: "model_usage_receiver_unavailable", message: "listen EADDRINUSE" }),
  );
  await f.attach();
  expect(f.agent.getHealth()).toMatchObject({ status: "ready" });
  expect(f.options()?.env?.OTEL_LOGS_EXPORTER).toBeUndefined();
  expect(
    f.history.view.some(
      (record) => record.type === "event" && record.eventType === "claude.model_usage_unavailable",
    ),
  ).toBe(true);
  f.exit();
});

it("persists restart claim and owns admission before query initialization", async () => {
  const f = fixture();
  f.persist({ type: "user", uuid: "human", message: { role: "user", content: "continue work" } });
  await f.attach(true);
  expect(f.agent.getHealth()).toMatchObject({
    status: "ready",
    activity: "busy",
    turnResume: { outcome: "resumed" },
  });
  expect(
    f.history.view.some(
      (record) => record.type === "event" && record.eventType === "pi-orb.turn-resume",
    ),
  ).toBe(true);
  expect(
    (
      await f.agent.deliverInboxMessage("later", ["later"], [{ type: "text", text: "human later" }])
    )._unsafeUnwrap(),
  ).toMatchObject({ delivery: "steer", operationId: f.agent.gateView().activeOperationId });
  expect(f.agent.prepareIdleStop()._unsafeUnwrap()).toBe(false);
  f.exit();
});

it("cancels a restart continuation at the account barrier before native prompt submission", async () => {
  const f = fixture(undefined, true);
  f.persist({ type: "user", uuid: "human", message: { role: "user", content: "work" } });
  const attached = f.attach(true);
  await f.awaitCloseRequest(1);
  f.blockAccount();
  f.exit();
  expect((await attached).isOk()).toBe(true);
  const input = f.prompt()?.[Symbol.asyncIterator]();
  const next = input?.next();
  const aborted = f.agent.abortOperation();
  f.releaseAccount();
  f.exit();
  await aborted;
  expect(await next).toMatchObject({ done: true });
  expect(f.state.deliveries).toEqual({});
  expect(
    f.history.view.some(
      (record) => record.type === "event" && record.eventType === "pi-orb.turn-resume",
    ),
  ).toBe(true);
});

it("a boot prompt without a native receipt preserves retry budget rather than human-delivery uncertainty", async () => {
  const f = fixture();
  f.persist({ type: "user", uuid: "human", message: { role: "user", content: "work" } });
  await f.attach(true);
  const input = await f.prompt()?.[Symbol.asyncIterator]().next();
  expect(input?.done).toBe(false);
  expect(f.state.deliveries).toEqual({});
  expect(qualifyClaudeRestart(f.state, f.history.view, "after-crash").isOk()).toBe(true);
  expect(f.history.correlation(input?.value.uuid ?? "")).toMatchObject({ boot: true });
  f.exit();
});

it("declines exhausted claims without reopening inference and persists its decision", async () => {
  const f = fixture();
  f.persist({ type: "user", uuid: "human", message: { role: "user", content: "work" } });
  f.history.scan(f.nativePath)._unsafeUnwrap();
  for (const id of ["a", "b", "c"])
    f.history
      .appendPlatform({
        id,
        parentId: null,
        timestamp: f.state.timestamp,
        type: "event",
        eventType: "pi-orb.turn-resume",
        overflow: { runtimeInstanceId: id, executionId: null, incarnation: "0" },
      })
      ._unsafeUnwrap();
  expect((await f.attach(true)).isOk()).toBe(true);
  expect(f.agent.getHealth()).toMatchObject({
    status: "ready",
    activity: "idle",
    turnResume: { outcome: "declined_already_resumed" },
  });
  expect(f.queryOptions).toHaveLength(1);
  expect(f.history.view.at(-1)).toMatchObject({
    eventType: "pi-orb.turn-resume-declined",
    custom: { display: true },
    overflow: { reason: "declined_already_resumed" },
  });
});

it("fails closed before inference when the boot claim cannot be committed", async () => {
  const f = fixture();
  f.persist({ type: "user", uuid: "human", message: { role: "user", content: "work" } });
  vi.spyOn(f.history, "appendPlatform").mockReturnValue(
    err({ type: "claude_history_error", message: "injected claim persistence failure" }),
  );
  expect((await f.attach(true)).isErr()).toBe(true);
  expect(f.agent.getHealth()).toMatchObject({
    status: "failed",
    error: { code: "claude_boot_publication_failed" },
  });
  expect(f.queryOptions).toHaveLength(1);
  expect(f.state.deliveries).toEqual({});
});

it("combines sleep context and deduplicates inbox retries without another native submission", async () => {
  const f = fixture();
  await f.attach();
  const wake = {
    messageId: "sleep",
    messageIds: ["sleep"],
    content: [{ type: "text" as const, text: "Wake now." }],
    system: { kind: "sleep_wake" as const, sleepUntil: "2026-10-06T00:00:00Z" },
  };
  const attached = await f.agent.attachSession(
    f.state,
    f.history,
    f.nativePath.slice(0, f.nativePath.indexOf("/projects/")),
    "commit",
    wake,
  );
  expect(attached.isOk()).toBe(true);
  expect(
    f.history.view.filter(
      (record) => record.type === "event" && record.eventType === "pi-orb.sleep-wake",
    ),
  ).toHaveLength(1);
  const duplicate = await f.agent.deliverInboxMessage(
    wake.messageId,
    wake.messageIds,
    wake.content,
    wake.system,
  );
  expect(duplicate._unsafeUnwrap()).toMatchObject({ duplicate: true, status: "persisted" });
  f.exit();
});

const result = rootResult;
const task = (subtype: "task_started" | "task_notification") =>
  ({
    type: "system",
    subtype,
    task_id: "child",
    description: "child",
    status: "completed",
    task_type: "local_agent",
    uuid: "event",
    session_id: "session",
  }) as unknown as SDKMessage;

it("starts fresh and rotated native queries explicitly on Opus, not the SDK default row", async () => {
  const f = fixture();
  expect((await f.attach()).isOk()).toBe(true);
  expect(f.queryOptions[0]?.model).toBe("opus");
  expect(f.state.model).toBe("opus");
  expect(f.selectedModels).toEqual(["opus"]);
  expect((await f.agent.submitMessage([{ type: "text", text: "hello" }], "op")).isOk()).toBe(true);
  expect(f.queryOptions.map((options) => options.model)).toEqual(["opus", "opus"]);
  f.exit();
  await f.agent.closeExtensions();
});
it("publishes only the four advertised latest native family aliases in picker order", async () => {
  const f = fixture();
  await f.attach();
  const settings = f.frames.find(
    (frame) => frame.type === "runtime.event" && frame.event.type === "agent_settings",
  );
  expect(settings).toMatchObject({
    event: {
      models: [
        { id: "fable", name: "Fable" },
        { id: "opus", name: "Opus" },
        { id: "sonnet", name: "Sonnet" },
        { id: "haiku", name: "Haiku", thinkingLevels: [] },
      ],
    },
  });
});
it("preserves a saved nondefault model in restoration and subsequent native queries", async () => {
  const f = fixture();
  f.state.model = "sonnet";
  f.state.effort = "low";
  f.persist({ type: "user", uuid: "saved", message: { content: "old" } });
  expect((await f.attach()).isOk()).toBe(true);
  expect(f.options()).toMatchObject({ model: "sonnet", effort: "low", resume: f.state.id });
  await f.agent.submitMessage([{ type: "text", text: "hello" }], "op");
  expect(f.queryOptions.map((options) => options.model)).toEqual(["sonnet", "sonnet"]);
  expect(f.selectedModels).toEqual(["sonnet", "sonnet"]);
  f.exit();
  await f.agent.closeExtensions();
});
it("restores saved exact model IDs without replacing them with a latest alias", async () => {
  const f = fixture();
  f.state.model = "claude-opus-saved-version";
  f.models([
    {
      value: "opus",
      resolvedModel: f.state.model,
      displayName: "Opus",
      description: "",
      supportedEffortLevels: ["low", "high"],
    },
  ]);
  expect((await f.attach()).isOk()).toBe(true);
  expect(f.options()?.model).toBe("claude-opus-saved-version");
  expect(f.state.model).toBe("claude-opus-saved-version");
  expect(
    (await f.agent.changeSettings({ type: "set_thinking", thinkingLevel: "low" })).isOk(),
  ).toBe(true);
  expect(f.state.model).toBe("claude-opus-saved-version");
});
it("does not silently fall back when Opus is not advertised", async () => {
  const f = fixture();
  f.models([
    { value: "sonnet", displayName: "Sonnet", description: "", supportedEffortLevels: ["high"] },
  ]);
  expect((await f.attach()).isErr()).toBe(true);
  expect(f.options()?.model).toBe("opus");
  expect(f.state.model).toBeUndefined();
  f.exit();
  await f.agent.closeExtensions();
});
it("selects and restores native Haiku without inventing an effort setting", async () => {
  const f = fixture();
  await f.attach();
  expect(
    (
      await f.agent.changeSettings({
        type: "set_model",
        model: { provider: "claude", id: "haiku" },
      })
    ).isOk(),
  ).toBe(true);
  expect(f.state.model).toBe("haiku");
  expect(f.state.effort).toBeUndefined();
  expect(f.flagSettings.at(-1)).toEqual({ effortLevel: null });
  expect(f.frames.at(-1)).toMatchObject({ event: { settings: { thinkingLevel: "off" } } });
  const flagsBeforeHaiku = f.flagSettings.length;
  expect((await f.agent.submitMessage([{ type: "text", text: "hello" }], "op")).isOk()).toBe(true);
  expect(f.options()?.model).toBe("haiku");
  expect(f.options()?.effort).toBeUndefined();
  expect(f.flagSettings).toHaveLength(flagsBeforeHaiku);
  f.exit();
  await f.agent.closeExtensions();
});
it.each(["fable", "opus", "sonnet", "haiku"])(
  "preserves saved %s in every native query",
  async (model) => {
    const f = fixture();
    f.state.model = model;
    expect((await f.attach()).isOk()).toBe(true);
    expect(f.options()?.model).toBe(model);
    await f.agent.submitMessage([{ type: "text", text: "hello" }], "op");
    expect(f.queryOptions.map((options) => options.model)).toEqual([model, model]);
    f.exit();
    await f.agent.closeExtensions();
  },
);
it("restores a saved non-picker model when its exact native metadata is advertised", async () => {
  const f = fixture();
  f.state.model = "claude-sonnet-old";
  f.models([
    {
      value: "claude-sonnet-old",
      displayName: "Old Sonnet",
      description: "",
      supportedEffortLevels: ["high"],
    },
  ]);
  expect((await f.attach()).isOk()).toBe(true);
  expect(f.state.model).toBe("claude-sonnet-old");
  expect(f.options()?.model).toBe("claude-sonnet-old");
});
it("holds root/child ownership through SDK close, actual process exit, and final history flush", async () => {
  const f = fixture();
  expect((await f.attach()).isOk()).toBe(true);
  await f.agent.submitMessage([{ type: "text", text: "hello" }], "op");
  await f.emit(task("task_started"));
  await f.emit(result);
  expect(f.agent.gateView().activity).toBe("busy");
  await f.emit(task("task_notification"));
  expect(f.agent.gateView().activity).toBe("busy");
  await f.emit(rootRequest);
  await f.emit(result);
  const delivery = Object.values(f.state.deliveries)[0];
  f.persist({
    type: "user",
    uuid: delivery?.uuid,
    timestamp: f.state.timestamp,
    message: { role: "user", content: "hello" },
  });
  f.exit();
  await f.agent.closeExtensions();
  expect(f.agent.gateView().activity).toBe("idle");
  const persistedIndex = f.frames.findIndex((frame) => frame.type === "history.record");
  const finishedIndex = f.frames.findIndex(
    (frame) => frame.type === "runtime.event" && frame.event.type === "operation_finished",
  );
  expect(persistedIndex).toBeGreaterThanOrEqual(0);
  expect(finishedIndex).toBeGreaterThan(persistedIndex);
});
it("awaits a new native root handoff after an asynchronous child's terminal notification", async () => {
  const f = fixture();
  await f.attach();
  await f.agent.submitMessage([{ type: "text", text: "hello" }], "op");
  await f.emit(task("task_started"));
  await f.emit(result);
  await f.emit(task("task_notification"));
  expect(f.closeRequests()).toBe(1);
  expect(f.agent.gateView().activity).toBe("busy");
  await f.emit(rootRequest);
  await f.emit(result);
  const delivery = Object.values(f.state.deliveries)[0];
  f.persist({ type: "user", uuid: delivery?.uuid, message: { content: "hello" } });
  f.exit();
  await f.agent.closeExtensions();
});
it("fails visibly on clean unexpected SDK EOF instead of exposing a dead ready query", async () => {
  const f = fixture();
  await f.attach();
  await f.agent.submitMessage([{ type: "text", text: "hello" }], "op");
  f.exit();
  await f.agent.waitForStream();
  expect(f.agent.getHealth()).toMatchObject({
    status: "failed",
    error: { code: "claude_stream_ended" },
  });
  await f.agent.closeExtensions();
});
it("persists hook-owned child admission until a terminal native notification", async () => {
  const f = fixture();
  await f.attach();
  await f.agent.submitMessage([{ type: "text", text: "hello" }], "op");
  const callback = f.options()?.hooks?.SubagentStart?.[0]?.hooks[0];
  await callback?.(
    {
      hook_event_name: "SubagentStart",
      agent_id: "child",
      agent_type: "general-purpose",
      session_id: f.state.id,
      transcript_path: "/private/root.jsonl",
      cwd: f.state.cwd,
    },
    undefined,
    { signal: new AbortController().signal },
  );
  expect(f.state.ownedChildren).toEqual({ child: "Native Claude agent" });
  await f.emit({
    type: "system",
    subtype: "background_tasks_changed",
    tasks: [],
    uuid: "event",
    session_id: f.state.id,
  } as unknown as SDKMessage);
  await f.emit(result);
  expect(f.agent.gateView().activity).toBe("busy");
  await f.emit(task("task_notification"));
  expect(f.state.ownedChildren).toEqual({});
  f.exit();
  await f.agent.closeExtensions();
});
it("retires only a committed assistant's own streamed blocks", async () => {
  const f = fixture();
  await f.attach();
  await f.agent.submitMessage([{ type: "text", text: "hello" }], "op");
  await f.emit({
    type: "stream_event",
    parent_tool_use_id: null,
    uuid: "stream",
    session_id: f.state.id,
    event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  } as unknown as SDKMessage);
  await f.emit({
    type: "stream_event",
    parent_tool_use_id: null,
    uuid: "delta",
    session_id: f.state.id,
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "answer" } },
  } as unknown as SDKMessage);
  const blockId = f.agent.liveView()?.blocks[0]?.blockId;
  expect(blockId).toBeDefined();
  f.persist({
    type: "assistant",
    uuid: "assistant",
    timestamp: f.state.timestamp,
    message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
  });
  expect(
    f.agent
      .snapshot()
      ._unsafeUnwrap()
      .records.some((record) => record.id === "assistant"),
  ).toBe(false);
  expect(f.agent.liveView()?.blocks).toHaveLength(1);
  await f.emit({
    type: "assistant",
    parent_tool_use_id: null,
    uuid: "assistant",
    session_id: f.state.id,
    message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
  } as unknown as SDKMessage);
  expect(
    f.frames.find((frame) => frame.type === "history.record" && frame.record.id === "assistant"),
  ).toMatchObject({ retiredBlockIds: [blockId] });
  expect(f.agent.liveView()?.blocks).toEqual([]);
  f.exit();
  await f.agent.closeExtensions();
});
it.each(["new", "already-published"] as const)(
  "aliases only retained reasoning in the UUID-owned group: %s",
  async (publication) => {
    const f = fixture();
    await f.attach();
    await f.agent.submitMessage([{ type: "text", text: "hello" }], "op");
    const content = [
      { type: "thinking", thinking: "" },
      { type: "text", text: "Answer" },
      { type: "thinking", thinking: "PRIVATE_HEADINGLESS" },
      { type: "redacted_thinking", data: "ENCRYPTED_CANARY" },
    ];
    const persist = () =>
      f.persist({
        type: "assistant",
        uuid: "owned-assistant",
        timestamp: f.state.timestamp,
        message: { role: "assistant", content },
      });
    if (publication === "already-published") {
      persist();
      expect(f.agent.snapshot().isOk()).toBe(true);
      const frame = f.frames.find(
        (frame) => frame.type === "history.record" && frame.record.id === "owned-assistant",
      );
      expect(frame).toMatchObject({ retiredBlockIds: [] });
      expect(frame).not.toHaveProperty("detailAliases");
    }
    for (const index of [3, 0, 2, 1])
      await f.emit({
        type: "stream_event",
        parent_tool_use_id: null,
        uuid: `stream-${index}`,
        session_id: f.state.id,
        event: { type: "content_block_start", index, content_block: content[index] },
      } as unknown as SDKMessage);
    await f.emit({
      type: "assistant",
      parent_tool_use_id: null,
      uuid: "owned-assistant",
      session_id: f.state.id,
      message: { role: "assistant", content },
    } as unknown as SDKMessage);
    if (publication === "new") {
      await f.emit({
        type: "stream_event",
        parent_tool_use_id: null,
        uuid: "next-stream",
        session_id: f.state.id,
        event: {
          type: "content_block_start",
          index: 2,
          content_block: { type: "thinking", thinking: "PRIVATE_NEXT" },
        },
      } as unknown as SDKMessage);
      persist();
      expect(f.agent.snapshot().isOk()).toBe(true);
      expect(f.agent.liveView()?.blocks.map((block) => block.blockId)).toEqual(["next-stream:2"]);
    }
    const handoff = f.frames
      .filter((frame) => frame.type === "history.record" && frame.record.id === "owned-assistant")
      .at(-1);
    expect(handoff).toMatchObject({
      retiredBlockIds: ["stream-3:3", "stream-0:0", "stream-2:2", "stream-1:1"],
      detailAliases: [
        { blockId: "stream-3:3", detailKey: "owned-assistant:3" },
        { blockId: "stream-2:2", detailKey: "owned-assistant:2" },
      ],
    });
    expect(JSON.stringify(f.frames)).not.toMatch(
      /PRIVATE_|ENCRYPTED_|contentIndex|reasoningVisible/,
    );
    if (publication === "new") {
      const nextContent = [
        { type: "text", text: "" },
        { type: "text", text: "" },
        { type: "thinking", thinking: "PRIVATE_NEXT" },
      ];
      f.persist({
        type: "assistant",
        uuid: "next-assistant",
        timestamp: f.state.timestamp,
        message: { role: "assistant", content: nextContent },
      });
      await f.emit({
        type: "assistant",
        parent_tool_use_id: null,
        uuid: "next-assistant",
        session_id: f.state.id,
        message: { role: "assistant", content: nextContent },
      } as unknown as SDKMessage);
    }
    expect(f.agent.liveView()?.blocks).toEqual([]);
    f.exit();
    await f.agent.closeExtensions();
  },
);

it.each(["status", "assistant"] as const)(
  "keeps busy when late native inference starts race query rotation (%s)",
  async (source) => {
    const f = fixture();
    await f.attach();
    await f.agent.submitMessage([{ type: "text", text: "hello" }], "op");
    const delivery = Object.values(f.state.deliveries)[0];
    f.persist({ type: "user", uuid: delivery?.uuid, message: { content: "hello" } });
    await f.emit({
      ...result,
      uuid: "drain-result",
      num_turns: 1,
      queued_turn_count: 0,
      stop_reason: "end_turn",
      result: "private-result",
    } as unknown as SDKMessage);
    await f.emit(
      (source === "status"
        ? {
            type: "system",
            subtype: "status",
            status: "requesting",
            uuid: "event",
            session_id: f.state.id,
          }
        : {
            type: "assistant",
            parent_tool_use_id: null,
            uuid: "event",
            session_id: f.state.id,
            error: "rate_limit",
            message: { content: [] },
          }) as unknown as SDKMessage,
    );
    await f.emit({
      type: "system",
      subtype: "status",
      status: "requesting",
      uuid: "later-event",
      session_id: f.state.id,
    } as unknown as SDKMessage);
    expect(f.agent.gateView().activity).toBe("busy");
    f.exit();
    await f.agent.closeExtensions();
    expect(f.agent.getHealth()).toMatchObject({ status: "failed" });
    expect(f.agent.gateView().activity).toBe("busy");
    const failure = f.history.view.find(
      (record) => record.type === "event" && record.eventType === "claude.rotation_failed",
    );
    expect(failure).toMatchObject({
      custom: { display: true },
      overflow: {
        reason: "root_work",
        rootWork: {
          operationId: "op",
          nativeSessionId: f.state.id,
          messageId: "event",
          messageType: source === "status" ? "system" : "assistant",
          priorResult: {
            resultId: "drain-result",
            numTurns: 1,
            queuedTurns: 0,
            stopReason: "end_turn",
          },
        },
      },
    });
    expect(JSON.stringify(failure)).not.toContain("private-result");
    if (source === "assistant")
      expect(
        f.history.view.find(
          (record) => record.type === "event" && record.eventType === "claude.assistant_error",
        ),
      ).toMatchObject({
        custom: { display: true },
        overflow: { category: "rate_limit", messageId: "event" },
      });
  },
);
it.each(["rotation", "interrupt"] as const)(
  "%s native hook drain cannot ignore an unmatched late start after final EOF",
  async (kind) => {
    const f = fixture();
    expect((await f.attach()).isOk()).toBe(true);
    expect(
      (
        await f.agent.deliverInboxMessage("inbox", ["inbox"], [{ type: "text", text: "hello" }])
      ).isOk(),
    ).toBe(true);
    const delivery = f.state.deliveries["inbox"];
    expect(delivery).toBeDefined();
    f.persist({ type: "user", uuid: delivery?.uuid, message: { content: "hello" } });
    const aborted = kind === "interrupt" ? f.agent.abortOperation() : null;
    if (kind === "rotation") await f.emit(result);
    await f.awaitCloseRequest(2);
    f.exitWithoutOutput();
    await f.emit(nativeHook("late-hook", "SessionStart"));
    await f.emit(nativeHookResponse(nativeHook("other")));
    f.endOutput();
    await f.agent.closeExtensions();
    if (aborted !== null) expect((await aborted).isErr()).toBe(true);
    expect(f.agent.getHealth()).toMatchObject({ status: "failed" });
    expect(f.agent.gateView()).toMatchObject({ activity: "busy", acceptingWork: false });
    expect(f.agent.prepareIdleStop().isErr()).toBe(true);
    expect(
      f.history.view.find(
        (record) => record.type === "event" && record.eventType === "claude.rotation_failed",
      ),
    ).toMatchObject({ custom: { display: true }, overflow: { reason: "owned_work" } });
    expect(
      f.history.view.some(
        (record) => record.type === "event" && record.eventType === "claude.operation_finished",
      ),
    ).toBe(false);
    expect(
      f.frames.some(
        (frame) => frame.type === "runtime.event" && frame.event.type === "operation_finished",
      ),
    ).toBe(false);
    expect(f.history.view.find((record) => record.id === delivery?.uuid)).toMatchObject({
      inboxMessageIds: ["inbox"],
    });
    expect(
      qualifyClaudeRestart(f.state, f.history.view, "new-compute")._unsafeUnwrap(),
    ).toMatchObject({ interruptedOperations: [delivery?.operationId] });
    expect(
      (await f.agent.submitMessage([{ type: "text", text: "blocked" }], "blocked")).isErr(),
    ).toBe(true);
    expect(JSON.stringify({ frames: f.frames, records: f.history.view })).not.toContain(
      "private-hook",
    );
  },
);
it.each(["rotation", "interrupt"] as const)(
  "%s native hook drain accepts a matching cancelled response, not a historical hook failure",
  async (kind) => {
    const f = fixture();
    expect((await f.attach()).isOk()).toBe(true);
    await f.agent.submitMessage([{ type: "text", text: "hello" }], "op");
    const delivery = Object.values(f.state.deliveries)[0];
    f.persist({ type: "user", uuid: delivery?.uuid, message: { content: "hello" } });
    const aborted = kind === "interrupt" ? f.agent.abortOperation() : null;
    if (kind === "rotation") await f.emit(result);
    await f.awaitCloseRequest(2);
    const started = nativeHook("late-hook", "SessionStart");
    await f.emit(started);
    f.exitWithoutOutput();
    expect(f.agent.gateView().activity).toBe("busy");
    await f.emit(nativeHookResponse(started, "cancelled"));
    f.endOutput();
    await f.agent.closeExtensions();
    if (aborted !== null) expect((await aborted).isOk()).toBe(true);
    expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
    expect(
      f.history.view.find(
        (record) => record.type === "event" && record.eventType === "claude.operation_finished",
      ),
    ).toMatchObject({ overflow: { outcome: kind === "interrupt" ? "aborted" : "completed" } });
    expect(JSON.stringify({ frames: f.frames, records: f.history.view })).not.toContain(
      "private-hook",
    );
  },
);
it("waits for final SDK stdout after process exit", async () => {
  const f = fixture();
  await f.attach();
  await f.agent.submitMessage([{ type: "text", text: "hello" }], "op");
  const delivery = Object.values(f.state.deliveries)[0];
  f.persist({ type: "user", uuid: delivery?.uuid, message: { content: "hello" } });
  await f.emit(result);
  f.exitWithoutOutput();
  expect(f.agent.gateView().activity).toBe("busy");
  f.endOutput();
  await f.agent.closeExtensions();
  expect(f.agent.gateView().activity).toBe("idle");
});
it("blocks inference if effective native settings selected API billing", async () => {
  const f = fixture({
    apiProvider: "firstParty",
    apiKeySource: "apiKeyHelper",
    tokenSource: "none",
  });
  expect((await f.attach()).isErr()).toBe(true);
  expect((await f.agent.submitMessage([{ type: "text", text: "hello" }], "op")).isErr()).toBe(true);
  expect(f.agent.getHealth()).toMatchObject({
    status: "failed",
    error: { code: "claude_auth_required" },
  });
  f.exit();
  await f.agent.closeExtensions();
});
it("retains busy on final fsync failure rather than advertising a safe idle stop", async () => {
  const f = fixture();
  await f.attach();
  await f.agent.submitMessage([{ type: "text", text: "hello" }], "op");
  await f.emit(result);
  f.persist({ type: "user", uuid: "u", message: { content: "hello" } });
  f.failHistory();
  f.exit();
  await f.agent.closeExtensions();
  expect(f.agent.gateView().activity).toBe("busy");
  expect(f.agent.prepareIdleStop().isErr()).toBe(true);
});
it("rejects effort values the native model did not advertise", async () => {
  const f = fixture();
  await f.attach();
  expect(
    (
      await f.agent.changeSettings({ type: "set_thinking", thinkingLevel: "max" })
    )._unsafeUnwrapErr(),
  ).toMatchObject({ code: "invalid_request" });
  expect(
    (
      await f.agent.changeSettings({ type: "set_thinking", thinkingLevel: "off" })
    )._unsafeUnwrapErr(),
  ).toMatchObject({ code: "unsupported" });
  f.exit();
  await f.agent.closeExtensions();
});
it("failed query startup leaves no queued durable acceptance and releases configuration ownership", async () => {
  const f = fixture();
  await f.attach();
  f.exit();
  await f.agent.closeExtensions();
  f.failNextQuery();
  expect(
    (
      await f.agent.deliverInboxMessage("inbox", ["inbox"], [{ type: "text", text: "hello" }])
    ).isErr(),
  ).toBe(true);
  expect(f.state.deliveries).toEqual({});
});
it("query initialization failure releases the settings guard", async () => {
  const f = fixture();
  await f.attach();
  f.exit();
  await f.agent.closeExtensions();
  f.failNextQuery();
  expect(
    (await f.agent.changeSettings({ type: "set_thinking", thinkingLevel: "low" })).isErr(),
  ).toBe(true);
  expect(f.agent.gateView().configuring).toBe(false);
});
it("cancellation while initialization is pending cannot enqueue inference", async () => {
  const f = fixture();
  await f.attach();
  f.exit();
  await f.agent.closeExtensions();
  f.blockAccount();
  const submitted = f.agent.submitMessage([{ type: "text", text: "hello" }], "op");
  const aborted = f.agent.abortOperation();
  f.releaseAccount();
  f.exit();
  await aborted;
  expect((await submitted).isErr()).toBe(true);
  expect(f.state.deliveries).toEqual({});
  f.exit();
  await f.agent.closeExtensions();
});
it("initialization remains busy until its probe subprocess and stdout have drained", async () => {
  const f = fixture(undefined, true);
  const initialized = f.attach();
  expect(f.agent.gateView().activity).toBe("busy");
  expect(f.agent.getHealth().status).not.toBe("ready");
  await f.awaitCloseRequest(1);
  f.exit();
  expect((await initialized).isOk()).toBe(true);
  expect(f.agent.gateView().activity).toBe("idle");
  expect(f.agent.prepareIdleStop()._unsafeUnwrap()).toBe(true);
});

it("retains visible SDK error diagnostics across later success and history reopen", async () => {
  const f = fixture();
  await f.attach();
  await f.agent.submitMessage([{ type: "text", text: "hello" }], "op");
  const delivery = Object.values(f.state.deliveries)[0];
  f.persist({ type: "user", uuid: delivery?.uuid, message: { content: "hello" } });
  const emit = (message: object) =>
    f.emit({ uuid: "error", session_id: f.state.id, ...message } as unknown as SDKMessage);
  const assistant = {
    type: "assistant",
    parent_tool_use_id: null,
    error: "rate_limit",
    message: { content: [{ type: "text", text: "Rate limited; Bearer private-token" }] },
  };
  const errors = () =>
    f.history.view.filter(
      (record) =>
        record.type === "event" && /claude\.(assistant|result)_error/.test(record.eventType),
    );
  await emit({ ...assistant, parent_tool_use_id: "child" });
  await emit({ ...assistant, error: undefined });
  expect(errors()).toEqual([]);
  await emit(assistant);
  expect(errors()[0]).toMatchObject({
    overflow: {
      category: "rate_limit",
      errorText: "Rate limited; [redacted]",
      apiErrorStatus: null,
    },
  });
  for (const subtype of [
    "error_during_execution",
    "error_max_turns",
    "error_max_budget_usd",
    "error_max_structured_output_retries",
  ]) {
    await emit({
      ...rootResult,
      subtype,
      is_error: subtype !== "error_max_turns",
      errors: ["socket failed"],
    });
    expect(errors().at(-1)).toMatchObject({
      overflow: {
        category: subtype,
        errors: ["socket failed"],
        errorText: null,
        apiErrorStatus: null,
      },
    });
  }
  await emit({ ...rootResult, is_error: true, result: "Overloaded", api_error_status: 529 });
  expect(errors().at(-1)).toMatchObject({
    overflow: {
      category: "api_error",
      subtype: "success",
      isError: true,
      errorText: "Overloaded",
      apiErrorStatus: 529,
      errors: [],
    },
  });
  await f.emit(rootResult);
  f.exit();
  await f.agent.closeExtensions();
  expect(errors()).toHaveLength(6);
  for (const record of errors()) {
    expect(record.overflow).toMatchObject({
      sessionId: f.state.id,
      nativeSessionId: f.state.id,
      operationId: "op",
      queryId: expect.any(String),
      messageId: "error",
      truncated: false,
    });
    expect(projectDisplayRecord(record)).toMatchObject({
      custom: { display: true },
      content: [
        {
          type: "text",
          text: `Claude error: ${record.overflow.category}${record.overflow.apiErrorStatus === null ? "" : " (HTTP 529)"}.`,
        },
      ],
    });
    expect(f.frames).toContainEqual(
      expect.objectContaining({ type: "history.record", record: projectDisplayRecord(record) }),
    );
  }
  const retained = new ClaudeHistory(join(f.dir, "claude"), f.state.id, f.state.timestamp);
  expect(
    retained.view.filter((record) => errors().some((error) => error.id === record.id)),
  ).toEqual(errors());
  expect(
    f.history.view.find(
      (record) => record.type === "event" && record.eventType === "claude.operation_finished",
    ),
  ).toMatchObject({ overflow: { outcome: "failed" } });
});

it.each(["result", "assistant"] as const)(
  "fails closed if %s diagnostics cannot be committed",
  async (type) => {
    const f = fixture();
    await f.attach();
    await f.agent.submitMessage([{ type: "text", text: "hello" }], "op");
    const append = vi
      .spyOn(f.history, "appendPlatform")
      .mockReturnValue(
        err({ type: "claude_history_error", message: "injected diagnostic commit failure" }),
      );
    await f.emit({
      type,
      ...(type === "result"
        ? { subtype: "success", is_error: true, result: "API failed", api_error_status: 500 }
        : { parent_tool_use_id: null, error: "rate_limit", message: { content: [] } }),
    } as SDKMessage);
    expect(f.agent.getHealth()).toMatchObject({
      status: "failed",
      error: { code: "history_unavailable" },
    });
    expect(f.frames).not.toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({ type: "operation_finished", outcome: "completed" }),
      }),
    );
    append.mockRestore();
    f.exit();
    await f.agent.closeExtensions();
  },
);

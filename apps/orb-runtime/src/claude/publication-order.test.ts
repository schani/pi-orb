import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ServerFrame } from "@pi-orb/protocol";
import { ok } from "neverthrow";
import { afterEach, expect, it } from "vitest";
import { ClaudeOrbAgent, type ClaudeQuery, type NativeState } from "./agent.ts";
import { ClaudeHistory, nativeHistoryFiles } from "./history.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "claude-publication-"));
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
  const messages: { message: SDKMessage; processed: () => void }[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  let exiting: () => void = () => undefined;
  let stdoutDone: () => void = () => undefined;
  let closeRequests = 0;
  let nativeReads = 0;
  const closeWaiters: { count: number; resolve: () => void }[] = [];
  const exit = () => {
    exiting();
    stdoutDone();
    closed = true;
    wake?.();
  };
  const sdk: ClaudeQuery = {
    async *[Symbol.asyncIterator]() {
      while (!closed || messages.length > 0) {
        const entry = messages.shift();
        if (entry !== undefined) {
          yield entry.message;
          entry.processed();
        } else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
    },
    close: () => {
      closed = true;
      wake?.();
    },
    interrupt: async () => undefined,
    accountInfo: async () => ({
      apiProvider: "firstParty",
      apiKeySource: "none",
      tokenSource: "CLAUDE_CODE_OAUTH_TOKEN",
    }),
    supportedModels: async () => [
      {
        value: "opus",
        displayName: "Default (Opus)",
        description: "",
        supportedEffortLevels: ["low", "high"],
      },
    ],
    setModel: async () => undefined,
    applyFlagSettings: async () => undefined,
  };
  const history = new ClaudeHistory(join(dir, "claude"), state.id, state.timestamp, {
    ...nativeHistoryFiles,
    read: (path) => {
      if (path === nativePath) nativeReads++;
      return nativeHistoryFiles.read(path);
    },
  });
  const agent = new ClaudeOrbAgent({
    orbId: "o",
    repositoryUrl: "https://example.com/repo",
    workDir: dir,
    skillsDir: null,
    broker: null,
    sdkFactory: () => {
      closed = false;
      const exited = new Promise<void>((resolve) => {
        exiting = resolve;
      });
      const stdoutEnded = new Promise<void>((resolve) => {
        stdoutDone = resolve;
      });
      return ok({
        query: sdk,
        exited,
        stdoutEnded: stdoutEnded.then(() => ok(undefined)),
        requestShutdown: () => {
          closeRequests++;
          for (const waiter of closeWaiters.filter((waiter) => waiter.count <= closeRequests))
            waiter.resolve();
          if (Object.keys(state.deliveries).length === 0) exit();
          return ok(undefined);
        },
      });
    },
  });
  agent.subscribe((frame) => frames.push(frame));
  return {
    agent,
    state,
    history,
    frames,
    nativeReads: () => nativeReads,
    attach: () => agent.attachSession(state, history, configDir, "commit"),
    emit: (message: SDKMessage) =>
      new Promise<void>((resolve) => {
        messages.push({ message, processed: resolve });
        wake?.();
      }),
    awaitCloseRequest: (count: number) =>
      closeRequests >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => closeWaiters.push({ count, resolve })),
    exit,
    persist: (entry: object) => appendFileSync(nativePath, `${JSON.stringify(entry)}\n`),
  };
}

it.each([
  "before-blocks",
  "after-blocks",
  "missing-uuid",
  "mismatched-uuid",
  "unbound-block",
  "partial-multi-block",
  "multi-block",
  "role-mismatch",
] as const)("native-only recovery assistant ordering: %s", async (ordering) => {
  const f = fixture();
  expect((await f.attach()).isOk()).toBe(true);
  expect((await f.agent.submitMessage([{ type: "text", text: "continue" }], "op")).isOk()).toBe(
    true,
  );
  const delivery = Object.values(f.state.deliveries)[0];
  const appendRecovery = () =>
    f.persist({
      type: "assistant",
      uuid: "recovery-assistant",
      parentUuid: null,
      message: {
        role: "assistant",
        id: "recovery-sdk-id",
        stop_reason: "stop_sequence",
        content: [{ type: "text", text: "interrupted" }],
      },
    });
  const appendPrefix = () => {
    appendRecovery();
    f.persist({
      type: "user",
      uuid: delivery?.uuid,
      parentUuid: "recovery-assistant",
      message: { content: "continue" },
    });
  };
  if (ordering === "before-blocks") {
    appendPrefix();
    // Native user echo is an explicit pre-block publication checkpoint.
    await f.emit({
      type: "user",
      uuid: delivery?.uuid,
      session_id: f.state.id,
      parent_tool_use_id: null,
      message: { role: "user", content: "continue" },
    } as unknown as SDKMessage);
  }
  await f.emit({
    type: "stream_event",
    parent_tool_use_id: null,
    uuid: "start",
    session_id: f.state.id,
    event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  } as unknown as SDKMessage);
  if (ordering !== "before-blocks") appendPrefix();
  if (["unbound-block", "multi-block"].includes(ordering)) {
    await f.emit({
      type: "stream_event",
      parent_tool_use_id: null,
      uuid: "start",
      session_id: f.state.id,
      event: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    } as unknown as SDKMessage);
  }
  await f.emit({
    type: "assistant",
    parent_tool_use_id: null,
    uuid: ["missing-uuid", "unbound-block"].includes(ordering) ? undefined : "final-assistant",
    session_id: f.state.id,
    message: {
      role: "assistant",
      id: "final-sdk-id",
      content:
        ordering === "unbound-block"
          ? []
          : ordering === "multi-block"
            ? [
                { type: "text", text: "answer" },
                { type: "text", text: "second" },
              ]
            : [{ type: "text", text: "answer" }],
    },
  } as unknown as SDKMessage);
  if (ordering === "partial-multi-block") {
    await f.emit({
      type: "stream_event",
      parent_tool_use_id: null,
      uuid: "next",
      session_id: f.state.id,
      event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    } as unknown as SDKMessage);
  }
  await f.emit({ type: "result", subtype: "success", is_error: false } as unknown as SDKMessage);
  await f.awaitCloseRequest(2);
  const beforeExitReads = f.nativeReads();
  f.persist({
    type: ordering === "role-mismatch" ? "user" : "assistant",
    uuid: ordering === "mismatched-uuid" ? "other-assistant" : "final-assistant",
    parentUuid: delivery?.uuid,
    message: {
      role: ordering === "role-mismatch" ? "user" : "assistant",
      id: "final-sdk-id",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "answer" }],
    },
  });
  f.exit();
  await f.agent.closeExtensions();
  await f.agent.waitForStream();
  expect(f.nativeReads()).toBeGreaterThan(beforeExitReads);
  const records = f.frames.filter((frame) => frame.type === "history.record");
  const blocked = [
    "missing-uuid",
    "mismatched-uuid",
    "unbound-block",
    "partial-multi-block",
    "role-mismatch",
  ].includes(ordering);
  if (blocked) {
    expect(f.agent.getHealth()).toMatchObject({
      status: "failed",
      error: { code: "claude_stream_identity_gap" },
    });
    expect(records).toEqual([]);
    expect(f.agent.liveView()?.blocks.length).toBe(
      ["missing-uuid", "mismatched-uuid", "role-mismatch"].includes(ordering) ? 1 : 2,
    );
    return;
  }
  expect(f.history.view.some((row) => row.id === "final-assistant")).toBe(true);
  expect(f.agent.getHealth()).toMatchObject({ status: "ready" });
  expect(f.agent.gateView().activity).toBe("idle");
  expect(records.map((frame) => frame.record.id)).toEqual([
    "recovery-assistant",
    delivery?.uuid,
    "final-assistant",
    "claude.operation:op",
  ]);
  expect(records.map((frame) => frame.retiredBlockIds)).toEqual([
    [],
    [],
    ordering === "multi-block" ? ["start:0", "start:1"] : ["start:0"],
    [],
  ]);
  expect(f.agent.liveView()).toBeNull();
});

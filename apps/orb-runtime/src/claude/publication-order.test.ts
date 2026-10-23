import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ServerFrame } from "@pi-orb/protocol";
import { ok } from "neverthrow";
import { afterEach, expect, it } from "vitest";
import { ScheduledClaudeQuery } from "../testkit/claude-composed.ts";
import { ClaudeOrbAgent, type NativeState } from "./agent.ts";
import { ClaudeHistory, nativeHistoryFiles } from "./history.ts";

function gapDiagnostics(agent: ClaudeOrbAgent) {
  const health = agent.getHealth();
  if (health.status !== "failed") throw new Error("expected failed health");
  expect(health.error).toMatchObject({ code: "claude_stream_identity_gap", retryable: false });
  return JSON.parse(health.error.message.slice(health.error.message.indexOf("{")));
}

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
  let sdk: ScheduledClaudeQuery;
  let closeRequests = 0;
  let nativeReads = 0;
  const closeWaiters: { count: number; resolve: () => void }[] = [];
  const exit = () => {
    sdk.exit();
    sdk.endOutput();
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
    sdkFactory: (input, options) => {
      sdk = new ScheduledClaudeQuery(input, options, false);
      Object.assign(sdk, {
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
      });
      return ok({
        query: sdk,
        exited: sdk.processExit.promise,
        stdoutEnded: sdk.stdoutEnded,
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
    emit: (message: SDKMessage) => sdk.emitUnscheduled(message),
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
  const published = f.frames.filter((frame) => frame.type === "history.record");
  const diagnostics = published.filter(
    (frame) =>
      frame.record.type === "event" && frame.record.eventType.startsWith("claude.continuation."),
  );
  expect(diagnostics.every((frame) => frame.retiredBlockIds.length === 0)).toBe(true);
  const records = published.filter((frame) => !diagnostics.includes(frame));
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
    const gap = gapDiagnostics(f.agent);
    expect(gap).toMatchObject({
      liveBlocks: ["missing-uuid", "mismatched-uuid", "role-mismatch"].includes(ordering) ? 1 : 2,
      published: 0,
      nativeLength: f.history.view.length,
      omittedBlocks: 0,
      firstUnpublished: { id: "recovery-assistant", type: "message", role: "assistant" },
    });
    expect(gap.blocks[0]).toEqual({
      id: "start:0",
      ownerCount: 1,
      owners: [
        {
          id: ["missing-uuid", "unbound-block"].includes(ordering) ? null : "final-assistant",
          match: ["missing-uuid", "unbound-block", "mismatched-uuid"].includes(ordering)
            ? "missing"
            : ordering === "role-mismatch"
              ? "wrong_role"
              : "assistant",
        },
      ],
    });
    if (ordering === "partial-multi-block")
      expect(gap.blocks[1]).toEqual({ id: "next:0", ownerCount: 0, owners: [] });
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

it("bounds diagnostic samples and redacts unsafe identities and content", async () => {
  const f = fixture();
  expect((await f.attach()).isOk()).toBe(true);
  expect((await f.agent.submitMessage([{ type: "text", text: "PRIVATE" }], "op")).isOk()).toBe(
    true,
  );
  const emit = (message: object) =>
    f.emit({ ...message, session_id: f.state.id, parent_tool_use_id: null } as SDKMessage);
  const content = [{ type: "text", text: "PRIVATE" }];
  const content_block = { type: "thinking", thinking: "PRIVATE", signature: "PRIVATE" };
  const ids = ["b".repeat(94), "PRIVATE/ID\n", "x".repeat(97), "omitted"];
  for (const [index, uuid] of ids.entries()) {
    for (let owner = 0; owner < 3; owner++) {
      await emit({
        type: "stream_event",
        uuid,
        event: { type: "content_block_start", index: 0, content_block },
      });
      await emit({
        type: "assistant",
        uuid: index === 0 ? (owner === 0 ? "a".repeat(96) : `owner-${owner}`) : `${uuid}-${owner}`,
        message: { role: "assistant", id: "PRIVATE", content },
      });
    }
  }
  f.persist({
    type: "assistant",
    uuid: "PRIVATE/NATIVE",
    parentUuid: null,
    message: { role: "assistant", content },
    metadata: "PRIVATE",
  });
  await emit({ type: "result", subtype: "success", is_error: false });
  await f.awaitCloseRequest(2);
  f.exit();
  await f.agent.closeExtensions();
  const gap = gapDiagnostics(f.agent);
  expect(gap).toMatchObject({
    liveBlocks: 4,
    published: 0,
    nativeLength: f.history.view.length,
    omittedBlocks: 1,
    firstUnpublished: { id: null, type: "message", role: "assistant" },
  });
  expect(gap.blocks).toEqual([
    {
      id: `${"b".repeat(94)}:0`,
      ownerCount: 3,
      owners: [
        { id: "a".repeat(96), match: "missing" },
        { id: "owner-1", match: "missing" },
      ],
    },
    ...[1, 2].map(() => ({
      id: null,
      ownerCount: 3,
      owners: Array(2).fill({ id: null, match: "missing" }),
    })),
  ]);
  const health = f.agent.getHealth();
  if (health.status !== "failed") throw new Error("expected failed health");
  expect(health.error.message.length).toBeLessThan(4096);
  expect(health.error.message).not.toMatch(/PRIVATE|owner-2|omitted:0/);
});

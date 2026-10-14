import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ServerFrame } from "@pi-orb/protocol";
import { ok } from "neverthrow";
import { afterEach, expect, it, vi } from "vitest";
import { ClaudeOrbAgent, type ClaudeQuery, type NativeState } from "./agent.ts";
import { ClaudeHistory, nativeHistoryFiles } from "./history.ts";

const diagnosticPrefix =
  "Native history and streamed output could not be correlated; inspection is required. ";
function gapDiagnostics(agent: ClaudeOrbAgent) {
  const health = agent.getHealth();
  expect(health).toMatchObject({
    status: "failed",
    error: { code: "claude_stream_identity_gap", retryable: false },
  });
  if (health.status !== "failed") throw new Error("expected failed health");
  expect(health.error.message.startsWith(diagnosticPrefix)).toBe(true);
  return JSON.parse(health.error.message.slice(diagnosticPrefix.length));
}

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
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
    const diagnostics = gapDiagnostics(f.agent);
    expect(diagnostics).toMatchObject({
      liveBlocks: ["missing-uuid", "mismatched-uuid", "role-mismatch"].includes(ordering) ? 1 : 2,
      published: 0,
      nativeLength: f.history.view.length,
      firstUnpublished: { id: "recovery-assistant", type: "message", role: "assistant" },
    });
    expect(diagnostics.blocks[0]).toMatchObject({
      id: "start:0",
      ownerCount: 1,
      owners: ["missing-uuid", "unbound-block"].includes(ordering)
        ? [{ id: null, match: "missing", record: null }]
        : [
            {
              id: "final-assistant",
              match:
                ordering === "mismatched-uuid"
                  ? "missing"
                  : ordering === "role-mismatch"
                    ? "wrong_role"
                    : "assistant",
              record:
                ordering === "mismatched-uuid"
                  ? null
                  : {
                      id: "final-assistant",
                      type: "message",
                      role: ordering === "role-mismatch" ? "user" : "assistant",
                    },
            },
          ],
    });
    if (ordering === "partial-multi-block")
      expect(diagnostics.blocks[1]).toEqual({ id: "next:0", ownerCount: 0, owners: [] });
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

it("diagnoses live blocks alone without completing or accepting work", async () => {
  const f = fixture();
  expect((await f.attach()).isOk()).toBe(true);
  expect(
    (await f.agent.submitMessage([{ type: "text", text: "PRIVATE_PROMPT" }], "op")).isOk(),
  ).toBe(true);
  const delivery = Object.values(f.state.deliveries)[0];
  f.persist({
    type: "user",
    uuid: delivery?.uuid,
    parentUuid: null,
    message: { role: "user", content: "PRIVATE_PROMPT" },
  });
  await f.emit({
    type: "user",
    uuid: delivery?.uuid,
    parent_tool_use_id: null,
    session_id: f.state.id,
    message: { role: "user", content: "PRIVATE_PROMPT" },
  } as unknown as SDKMessage);
  await f.emit({
    type: "stream_event",
    parent_tool_use_id: null,
    uuid: "unbound",
    session_id: f.state.id,
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "PRIVATE_OUTPUT" },
    },
  } as unknown as SDKMessage);
  await f.emit({ type: "result", subtype: "success", is_error: false } as unknown as SDKMessage);
  await f.awaitCloseRequest(2);
  f.exit();
  await f.agent.closeExtensions();
  expect(gapDiagnostics(f.agent)).toEqual({
    liveBlocks: 1,
    published: 1,
    nativeLength: 1,
    blocks: [{ id: "unbound:0", ownerCount: 0, owners: [] }],
    omittedBlocks: 0,
    firstUnpublished: null,
  });
  expect(f.agent.gateView().acceptingWork).toBe(false);
  expect(
    f.frames.some(
      (frame) => frame.type === "runtime.event" && frame.event.type === "operation_finished",
    ),
  ).toBe(false);
});

it("diagnoses an unpublished native record with no live blocks", async () => {
  const f = fixture();
  expect((await f.attach()).isOk()).toBe(true);
  expect(
    (await f.agent.submitMessage([{ type: "text", text: "PRIVATE_PROMPT" }], "op")).isOk(),
  ).toBe(true);
  expect(
    f.history
      .appendPlatform({
        id: "native-tail",
        parentId: null,
        timestamp: f.state.timestamp,
        type: "event",
        eventType: "claude.attachment",
        overflow: { secret: "PRIVATE_METADATA" },
      })
      .isOk(),
  ).toBe(true);
  // Inject scan/view divergence at the history seam; an ordinary zero-block scan publishes all rows.
  vi.spyOn(f.history, "scan").mockReturnValue(ok([]));
  await f.emit({ type: "result", subtype: "success", is_error: false } as unknown as SDKMessage);
  await f.awaitCloseRequest(2);
  f.exit();
  await f.agent.closeExtensions();
  expect(gapDiagnostics(f.agent)).toEqual({
    liveBlocks: 0,
    published: 0,
    nativeLength: 1,
    blocks: [],
    omittedBlocks: 0,
    firstUnpublished: { id: "native-tail", type: "event", role: null },
  });
  expect(f.agent.gateView().acceptingWork).toBe(false);
});

it.each([
  "secret/PRIVATE_SECRET\n",
  `https://secret.invalid/?token=PRIVATE_SECRET\n${"x".repeat(1000)}`,
  "x".repeat(97),
])(
  "bounds block/owner samples and IDs without copying content, signatures or metadata: %$",
  async (unsafeId) => {
    const f = fixture();
    expect((await f.attach()).isOk()).toBe(true);
    expect(
      (await f.agent.submitMessage([{ type: "text", text: "PRIVATE_PROMPT" }], "op")).isOk(),
    ).toBe(true);
    for (let index = 0; index < 7; index++) {
      for (let owner = 0; owner < (index === 0 ? 4 : 1); owner++) {
        await f.emit({
          type: "stream_event",
          parent_tool_use_id: null,
          uuid: index === 1 ? unsafeId : index === 0 ? "b".repeat(94) : `block-${index}`,
          session_id: f.state.id,
          event: {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "thinking",
              thinking: "PRIVATE_THINKING",
              signature: "PRIVATE_SIGNATURE",
            },
          },
        } as unknown as SDKMessage);
        await f.emit({
          type: "assistant",
          parent_tool_use_id: null,
          uuid:
            index === 1
              ? unsafeId
              : index === 0 && owner === 0
                ? "a".repeat(96)
                : `owner-${index}-${owner}`,
          session_id: f.state.id,
          message: {
            role: "assistant",
            id: "PRIVATE_SDK_ID",
            content: [{ type: "text", text: "PRIVATE_OUTPUT" }],
          },
        } as unknown as SDKMessage);
      }
    }
    f.persist({
      type: "assistant",
      uuid: `${unsafeId}-native`,
      parentUuid: null,
      message: { role: "assistant", content: [{ type: "text", text: "PRIVATE_NATIVE" }] },
      metadata: "PRIVATE_METADATA",
    });
    await f.emit({ type: "result", subtype: "success", is_error: false } as unknown as SDKMessage);
    await f.awaitCloseRequest(2);
    f.exit();
    await f.agent.closeExtensions();
    const diagnostics = gapDiagnostics(f.agent);
    expect(diagnostics).toMatchObject({
      liveBlocks: 7,
      published: 0,
      nativeLength: f.history.view.length,
      omittedBlocks: 4,
      firstUnpublished: { id: null, type: "message", role: "assistant" },
    });
    expect(diagnostics.blocks).toHaveLength(3);
    expect(diagnostics.blocks[0]).toMatchObject({ id: `${"b".repeat(94)}:0`, ownerCount: 4 });
    expect(diagnostics.blocks[0].owners.map((owner: { id: string }) => owner.id)).toEqual([
      "a".repeat(96),
      "owner-0-1",
    ]);
    expect(diagnostics.blocks[1]).toMatchObject({
      id: null,
      owners: [{ id: null, match: "missing" }],
    });
    const health = f.agent.getHealth();
    if (health.status !== "failed") throw new Error("expected failed health");
    expect(health.error.message.length).toBeLessThan(4096);
    expect(health.error.message).not.toMatch(/PRIVATE_|secret.invalid|owner-0-[23]|block-[3-6]/);
  },
);

it("bounds three blocks with two matched 96-character owners each", async () => {
  const f = fixture();
  expect((await f.attach()).isOk()).toBe(true);
  expect(
    (await f.agent.submitMessage([{ type: "text", text: "PRIVATE_PROMPT" }], "op")).isOk(),
  ).toBe(true);
  // Hold synthetic matched identities at the history seam instead of retiring their blocks.
  vi.spyOn(f.history, "scan").mockReturnValue(ok([]));
  const expectedBlocks = [];
  for (let index = 0; index < 3; index++) {
    const streamId = String(index).padStart(94, "b");
    const owners = [];
    for (let owner = 0; owner < 2; owner++) {
      const uuid = String(index * 2 + owner).padStart(96, "a");
      await f.emit({
        type: "stream_event",
        parent_tool_use_id: null,
        uuid: streamId,
        session_id: f.state.id,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "PRIVATE_OUTPUT" },
        },
      } as unknown as SDKMessage);
      await f.emit({
        type: "assistant",
        parent_tool_use_id: null,
        uuid,
        session_id: f.state.id,
        message: {
          role: "assistant",
          id: "PRIVATE_SDK_ID",
          content: [{ type: "text", text: "PRIVATE_OUTPUT" }],
        },
      } as unknown as SDKMessage);
      expect(
        f.history
          .appendPlatform({
            id: uuid,
            parentId: null,
            timestamp: f.state.timestamp,
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "PRIVATE_NATIVE" }],
            overflow: {},
          })
          .isOk(),
      ).toBe(true);
      owners.push({
        id: uuid,
        match: "assistant",
        record: { id: uuid, type: "message", role: "assistant" },
      });
    }
    expectedBlocks.push({ id: `${streamId}:0`, ownerCount: 2, owners });
  }
  await f.emit({ type: "result", subtype: "success", is_error: false } as unknown as SDKMessage);
  await f.awaitCloseRequest(2);
  f.exit();
  await f.agent.closeExtensions();
  expect(gapDiagnostics(f.agent)).toEqual({
    liveBlocks: 3,
    published: 0,
    nativeLength: 6,
    blocks: expectedBlocks,
    omittedBlocks: 0,
    firstUnpublished: expectedBlocks[0]?.owners[0]?.record,
  });
  const health = f.agent.getHealth();
  if (health.status !== "failed") throw new Error("expected failed health");
  expect(health.error.message.length).toBeLessThanOrEqual(4096);
  expect(health.error.message).not.toContain("PRIVATE_");
});

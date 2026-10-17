import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, it, onTestFinished } from "vitest";
import { ComposedClaudeFixture, rootRequest, rootResult } from "../testkit/claude-composed.ts";

const start = {
  type: "stream_event",
  parent_tool_use_id: null,
  uuid: "block",
  session_id: "session",
  event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
} as unknown as SDKMessage;
const delta = {
  ...start,
  event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "." } },
} as unknown as SDKMessage;

async function admit(f: ComposedClaudeFixture, id = "inbox") {
  expect(
    (await f.agent.deliverInboxMessage(id, [id], [{ type: "text", text: "hello" }])).isOk(),
  ).toBe(true);
  const input = await f.query.input.next();
  if (input.done === true) throw new Error("native input ended");
  f.receipt(input.value);
}

async function finish(f: ComposedClaudeFixture) {
  const query = f.query;
  query.exit();
  query.endOutput();
  await f.agent.closeExtensions();
}

async function fixture(scheduling?: ConstructorParameters<typeof ComposedClaudeFixture>[1]) {
  const f = new ComposedClaudeFixture(Promise.resolve(), scheduling);
  onTestFinished(async () => {
    f.failCommit = false;
    await finish(f);
    f.dispose();
  });
  expect((await f.attach()).isOk()).toBe(true);
  await admit(f);
  return f;
}

it("runs a check-phase callback before the buffered SDK burst tail using the production yield", async () => {
  const f = await fixture({});
  await f.query.enqueue(start);
  let patches = 0;
  let patchesAtProbe = -1;
  let complete: () => void = () => undefined;
  const probe = new Promise<void>((resolve) => {
    complete = resolve;
  });
  f.agent.subscribe((frame) => {
    if (frame.type !== "runtime.event" || frame.event.type !== "output_patch") return;
    if (++patches === 1) {
      setImmediate(() => {
        patchesAtProbe = patches;
        complete();
      });
    }
  });
  await Promise.all([...Array.from({ length: 256 }, () => f.query.enqueue(delta)), probe]);
  expect(patches).toBe(256);
  expect(patchesAtProbe).toBe(1);
});

it.each(["duplicate delivery", "replication snapshot"] as const)(
  "%s discovers late steering proof; partial events avoid I/O and all flush backstops remain",
  async (probe) => {
    const f = await fixture();
    await f.query.enqueue(rootRequest);
    const content = [{ type: "text" as const, text: "change course" }];
    const messageIds = ["steer-1", "steer-2"] as const;
    const accepted = (
      await f.agent.deliverInboxMessage(messageIds[0], messageIds, content)
    )._unsafeUnwrap();
    const input = await f.query.input.next();
    if (input.done === true || input.value.uuid === undefined)
      throw new Error("native steering input missing UUID");
    const uuid = input.value.uuid;
    expect(accepted).toMatchObject({ status: "queued", delivery: "steer", duplicate: false });
    const query = f.query;
    const operationId = f.agent.gateView().activeOperationId;
    expect(accepted.operationId).toBe(operationId);
    const prefix = structuredClone(f.history.view);
    const flushes = async (action: () => unknown) => {
      const previous = { ...f.historyIO };
      const result = await action();
      expect(f.historyIO.reads).toBeGreaterThan(previous.reads);
      expect(f.historyIO.syncs).toBeGreaterThan(previous.syncs);
      return result;
    };
    const before = { ...f.historyIO };
    let patches = 0;
    f.agent.subscribe((frame) => {
      if (frame.type !== "runtime.event" || frame.event.type !== "output_patch") return;
      if (++patches !== 1) return;
      // Native persistence arrives during the buffered burst, without a subsequent SDK echo.
      f.append({
        type: "attachment",
        uuid: "steer-attachment",
        sessionId: f.state.id,
        attachment: {
          type: "queued_command",
          source_uuid: uuid,
          delivery_id: "native-steer-delivery",
          prompt: "change course",
        },
      });
      f.append({
        type: "queue-operation",
        operation: "remove",
        reason: "absorbed_mid_turn",
        commandUuid: uuid,
        deliveryId: "native-steer-delivery",
        sessionId: f.state.id,
      });
    });
    await query.enqueue(start);
    await Promise.all(Array.from({ length: 16 }, () => query.enqueue(delta)));
    expect(patches).toBe(17);
    expect(f.historyIO).toEqual(before);
    expect(f.history.view.some((record) => record.id === uuid)).toBe(false);
    const nextInput = query.input.next();
    if (probe === "duplicate delivery") {
      const duplicate = (
        await f.agent.deliverInboxMessage(messageIds[0], messageIds, content)
      )._unsafeUnwrap();
      expect(duplicate).toEqual({ ...accepted, status: "persisted", duplicate: true });
    } else {
      const snapshot = f.agent.replicationSnapshot()._unsafeUnwrap();
      expect(snapshot.records.some((record) => record.id === uuid)).toBe(true);
    }
    expect(f.historyIO.reads).toBeGreaterThan(before.reads);
    expect(f.historyIO.syncs).toBeGreaterThan(before.syncs);
    expect(f.history.view.slice(0, prefix.length)).toEqual(prefix);
    expect(f.history.view.filter((record) => record.id === uuid)).toEqual([
      expect.objectContaining({
        id: uuid,
        type: "event",
        eventType: "claude.input_receipt",
        inboxMessageIds: messageIds,
        overflow: expect.objectContaining({
          sessionId: f.state.id,
          operationId,
        }),
      }),
    ]);
    expect(f.history.correlation(uuid)).toMatchObject({ messageIds, operationId });
    expect(f.agent.gateView()).toMatchObject({
      activity: "busy",
      activeOperationId: operationId,
    });
    expect(f.query).toBe(query);
    expect(
      f.frames.filter(
        (frame) => frame.type === "runtime.event" && frame.event.type === "operation_started",
      ),
    ).toHaveLength(1);
    await flushes(() => f.query.enqueue(rootRequest));
    await flushes(() => f.query.enqueue(input.value));
    await flushes(() => f.agent.appendAlert({ v: 1, requestId: "alert", message: "diagnostic" }));
    await flushes(() => f.agent.snapshot());
    await flushes(() =>
      f.agent.deliverInboxMessage("inbox", ["inbox"], [{ type: "text", text: "hello" }]),
    );
    const assistant = {
      type: "assistant",
      uuid: "assistant",
      session_id: "session",
      parent_tool_use_id: null,
      message: { role: "assistant", content: [{ type: "text", text: ".".repeat(16) }] },
    } as unknown as SDKMessage;
    f.append(assistant);
    await flushes(() => f.query.enqueue(assistant));
    await flushes(() => f.query.enqueue({ ...rootResult, user_message_uuid: uuid } as SDKMessage));
    await flushes(() => finish(f));
    expect(await nextInput).toEqual({ done: true, value: undefined });
    expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
  },
);

it("yields even when diagnostic persistence takes the consume-loop continue path", async () => {
  let yields = 0;
  const f = await fixture({
    yieldMessage: async () => {
      yields++;
    },
  });

  f.failCommit = true;
  const error = {
    ...rootResult,
    subtype: "error_during_execution",
    is_error: true,
    errors: ["injected native error"],
  } as unknown as SDKMessage;
  await Promise.all(Array.from({ length: 4 }, () => f.query.enqueue(error)));
  expect(yields).toBe(4);
  expect(f.agent.getHealth()).toMatchObject({
    status: "failed",
    error: { code: "history_unavailable" },
  });
});

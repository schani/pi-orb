import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "vitest";
import {
  ComposedClaudeFixture,
  childEdge,
  rootResult,
  type ScheduledClaudeQuery,
} from "../testkit/claude-composed.ts";

const content = (text: string) => [{ type: "text" as const, text }];
const resultFor = (...uuids: string[]) =>
  ({
    ...rootResult,
    user_message_uuid: uuids.at(-1),
    user_message_uuids: uuids,
    queued_turn_count: 0,
  }) as SDKMessage;

async function nextInput(query: ScheduledClaudeQuery): Promise<SDKUserMessage & { uuid: string }> {
  const input = await query.input.next();
  if (input.done || input.value.uuid === undefined) throw new Error("Native input missing UUID.");
  return { ...input.value, uuid: input.value.uuid };
}

async function start(f: ComposedClaudeFixture) {
  expect((await f.attach()).isOk()).toBe(true);
  const accepted = (
    await f.agent.deliverInboxMessage("first", ["first"], content("first"))
  )._unsafeUnwrap();
  const input = await nextInput(f.query);
  f.receipt(input);
  return { accepted, input };
}

it("sends human input with now priority and steers the active operation without restarting its query", async () => {
  const f = new ComposedClaudeFixture();
  try {
    const first = await start(f);
    expect(first.input).toMatchObject({ priority: "now", origin: { kind: "human" } });
    const accepted = (
      await f.agent.deliverInboxMessage("steer", ["steer"], content("change course"))
    )._unsafeUnwrap();
    expect(accepted).toMatchObject({ delivery: "steer", operationId: first.accepted.operationId });
    const input = await nextInput(f.query);
    expect(input).toMatchObject({ priority: "now", origin: { kind: "human" } });
    expect(f.journal().deliveries.steer).toMatchObject({
      uuid: input.uuid,
      operationId: first.accepted.operationId,
      steer: true,
    });
    expect(f.queries).toHaveLength(2);
    expect(f.agent.prepareIdleStop()._unsafeUnwrap()).toBe(false);
    const duplicate = (
      await f.agent.deliverInboxMessage("steer", ["steer"], content("change course"))
    )._unsafeUnwrap();
    expect(duplicate).toMatchObject({ ...accepted, duplicate: true });
    f.receipt(input);
    await f.query.emitUnscheduled(resultFor(first.input.uuid, input.uuid));
    expect(f.query.closeRequested).toBe(true);
    const duringDrain = await f.agent.deliverInboxMessage("late", ["late"], content("late"));
    expect(duringDrain.isErr()).toBe(true);
    expect(f.journal().deliveries.late).toBeUndefined();
    f.query.exit();
    f.query.endOutput();
    await f.agent.closeExtensions();
    expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
    expect(f.history.view.find((record) => record.id === input.uuid)).toMatchObject({
      inboxMessageIds: ["steer"],
    });
    expect(f.history.correlation(input.uuid)).toMatchObject({
      operationId: first.accepted.operationId,
    });
    expect(
      f.history.view.filter(
        (record) => record.type === "event" && record.eventType === "claude.operation_finished",
      ),
    ).toHaveLength(1);
    const persistedDuplicate = (
      await f.agent.deliverInboxMessage("steer", ["steer"], content("change course"))
    )._unsafeUnwrap();
    expect(persistedDuplicate).toMatchObject({
      delivery: "steer",
      duplicate: true,
      status: "persisted",
    });
  } finally {
    f.query.exit();
    f.query.endOutput();
    f.dispose();
  }
});

it("keeps the query open when now interrupts the old turn before the steering turn runs", async () => {
  const f = new ComposedClaudeFixture();
  try {
    const first = await start(f);
    expect((await f.agent.deliverInboxMessage("steer", ["steer"], content("change"))).isOk()).toBe(
      true,
    );
    const input = await nextInput(f.query);
    f.receipt(input);
    await f.query.emitUnscheduled(resultFor(first.input.uuid));
    expect(f.query.closeRequested).toBe(false);
    expect(f.agent.gateView().activity).toBe("busy");
    await f.query.emitUnscheduled(resultFor(input.uuid));
    expect(f.query.closeRequested).toBe(true);
    f.query.exit();
    f.query.endOutput();
    await f.agent.closeExtensions();
    expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
  } finally {
    f.query.exit();
    f.query.endOutput();
    f.dispose();
  }
});

it("admits steering after the root reply while native child work still owns the operation", async () => {
  const f = new ComposedClaudeFixture();
  try {
    const first = await start(f);
    await f.query.emitUnscheduled(childEdge("task_started"));
    await f.query.emitUnscheduled(resultFor(first.input.uuid));
    expect(f.query.closeRequested).toBe(false);
    const accepted = (
      await f.agent.deliverInboxMessage("steer", ["steer"], content("change"))
    )._unsafeUnwrap();
    expect(accepted).toMatchObject({ delivery: "steer", operationId: first.accepted.operationId });
    const input = await nextInput(f.query);
    f.receipt(input);
    await f.query.emitUnscheduled(childEdge("task_notification"));
    expect(f.query.closeRequested).toBe(false);
    await f.query.emitUnscheduled(resultFor(input.uuid));
    expect(f.query.closeRequested).toBe(true);
    f.query.exit();
    f.query.endOutput();
    await f.agent.closeExtensions();
    expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
  } finally {
    f.query.exit();
    f.query.endOutput();
    f.dispose();
  }
});

it("uses now for system input without attributing it to a human", async () => {
  const f = new ComposedClaudeFixture();
  try {
    await start(f);
    const system = { kind: "sleep_wake" as const, sleepUntil: "2026-10-12T00:00:00Z" };
    expect(
      (await f.agent.deliverInboxMessage("system", ["system"], content("wake"), system)).isOk(),
    ).toBe(true);
    const input = await nextInput(f.query);
    expect(input.priority).toBe("now");
    expect(input.origin).toBeUndefined();
    expect(f.journal().deliveries.system?.system).toEqual(system);
  } finally {
    f.query.exit();
    f.query.endOutput();
    f.dispose();
  }
});

it("settles a coalesced steering batch when the SDK caps its echoed UUID list at 64", async () => {
  const f = new ComposedClaudeFixture();
  try {
    await start(f);
    const uuids: string[] = [];
    for (let i = 0; i < 65; i++) {
      const id = `steer-${i}`;
      expect((await f.agent.deliverInboxMessage(id, [id], content(id))).isOk()).toBe(true);
      const input = await nextInput(f.query);
      f.receipt(input);
      uuids.push(input.uuid);
    }
    await f.query.emitUnscheduled(resultFor(...uuids.slice(-64)));
    expect(f.query.closeRequested).toBe(true);
    f.query.exit();
    f.query.endOutput();
    await f.agent.closeExtensions();
    expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
  } finally {
    f.query.exit();
    f.query.endOutput();
    f.dispose();
  }
});

it("retains later steering when an earlier steer has finished", async () => {
  const f = new ComposedClaudeFixture();
  try {
    await start(f);
    const uuids: string[] = [];
    for (const id of ["steer-one", "steer-two"]) {
      expect((await f.agent.deliverInboxMessage(id, [id], content(id))).isOk()).toBe(true);
      const input = await nextInput(f.query);
      f.receipt(input);
      uuids.push(input.uuid);
    }
    await f.query.emitUnscheduled(resultFor(uuids[0] ?? "missing"));
    expect(f.query.closeRequested).toBe(false);
    await f.query.emitUnscheduled(resultFor(uuids[1] ?? "missing"));
    expect(f.query.closeRequested).toBe(true);
  } finally {
    f.query.exit();
    f.query.endOutput();
    f.dispose();
  }
});

it("fails visibly before sending steering when input provenance cannot be committed", async () => {
  const f = new ComposedClaudeFixture();
  try {
    await start(f);
    f.failCommit = true;
    expect((await f.agent.deliverInboxMessage("steer", ["steer"], content("change"))).isErr()).toBe(
      true,
    );
    expect(f.state.deliveries.steer).toBeUndefined();
    expect(f.agent.getHealth()).toMatchObject({
      status: "failed",
      error: { code: "claude_input_persistence_failed" },
    });
    expect(f.agent.getHealth()).toMatchObject({
      error: { message: "Cannot commit Claude input provenance." },
    });
  } finally {
    f.query.exit();
    f.query.endOutput();
    f.dispose();
  }
});

it("holds input while a new query is initializing", async () => {
  let release: () => void = () => undefined;
  const account = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = new ComposedClaudeFixture(account);
  try {
    await f.attach();
    const next = f.nextQuery();
    const first = f.agent.deliverInboxMessage("first", ["first"], content("first"));
    await next;
    const steering = await f.agent.deliverInboxMessage("steer", ["steer"], content("change"));
    expect(steering.isErr()).toBe(true);
    expect(f.state.deliveries.steer).toBeUndefined();
    release();
    expect((await first).isOk()).toBe(true);
  } finally {
    release();
    f.query.exit();
    f.query.endOutput();
    f.dispose();
  }
});

import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ResultAsync } from "neverthrow";
import { expect, it } from "vitest";
import { ComposedClaudeFixture, rootResult } from "../testkit/claude-composed.ts";

const content = [{ type: "text" as const, text: "/help" }];
const resultFor = (input: SDKUserMessage, plural: boolean) =>
  ({
    ...rootResult,
    num_turns: 0,
    ...(plural ? { user_message_uuids: [input.uuid] } : { user_message_uuid: input.uuid }),
  }) as SDKMessage;
async function dispose(f: ComposedClaudeFixture) {
  f.query.exit();
  f.query.endOutput();
  await f.agent.closeExtensions();
  f.dispose();
}

it.each([false, true])(
  "unrelated results cannot settle initial input; own zero-turn command settles (plural=%s)",
  async (plural) => {
    const f = new ComposedClaudeFixture();
    try {
      (await f.attach())._unsafeUnwrap();
      (await f.agent.deliverInboxMessage("initial", ["initial"], content))._unsafeUnwrap();
      const input = (await f.query.input.next()).value;
      if (input === undefined) throw new Error("Missing input");
      f.receipt(input);
      for (const num_turns of [0, 2]) {
        await f.query.emitUnscheduled({
          ...rootResult,
          num_turns,
          user_message_uuids: ["unrelated"],
        } as SDKMessage);
        expect(f.query.closeRequested).toBe(false);
        expect(f.agent.gateView().activity).toBe("busy");
      }
      await f.query.emitUnscheduled(resultFor(input, plural));
      expect(f.query.closeRequested).toBe(true);
      f.query.exit();
      f.query.endOutput();
      await f.agent.closeExtensions();
      expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
    } finally {
      await dispose(f);
    }
  },
);

it("protects the unsubmitted initial input during asynchronous query startup", async () => {
  let release = () => {};
  const account = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = new ComposedClaudeFixture(account);
  try {
    (await f.attach())._unsafeUnwrap();
    const next = f.nextQuery();
    const admitted = f.agent.deliverInboxMessage("initial", ["initial"], content);
    await next;
    await f.query.emitUnscheduled({ ...rootResult, num_turns: 0 } as SDKMessage);
    expect(f.query.closeRequested).toBe(false);
    expect(f.state.deliveries.initial).toBeUndefined();
    release();
    expect((await admitted).isOk()).toBe(true);
    const input = (await f.query.input.next()).value;
    if (input === undefined) throw new Error("Missing input");
    f.receipt(input);
    await f.query.emitUnscheduled(resultFor(input, true));
    expect(f.query.closeRequested).toBe(true);
  } finally {
    release();
    await dispose(f);
  }
});

it("retains an unanswered initial input when a later steer alone finishes", async () => {
  const f = new ComposedClaudeFixture();
  try {
    (await f.attach())._unsafeUnwrap();
    (await f.agent.deliverInboxMessage("initial", ["initial"], content))._unsafeUnwrap();
    const initial = (await f.query.input.next()).value;
    if (initial === undefined) throw new Error("Missing input");
    f.receipt(initial);
    (await f.agent.deliverInboxMessage("steer", ["steer"], content))._unsafeUnwrap();
    const steer = (await f.query.input.next()).value;
    if (steer === undefined) throw new Error("Missing steer");
    f.receipt(steer);
    await f.query.emitUnscheduled(resultFor(steer, true));
    expect(f.query.closeRequested).toBe(false);
    await f.query.emitUnscheduled(resultFor(initial, true));
    expect(f.query.closeRequested).toBe(true);
  } finally {
    await dispose(f);
  }
});

it("abort before SDK creation releases the cancelled claim after startup settles", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = new ComposedClaudeFixture();
  try {
    (await f.attach())._unsafeUnwrap();
    const startup = f.agent as unknown as {
      startQuery: () => import("neverthrow").ResultAsync<void, { message: string }>;
    };
    const original = startup.startQuery.bind(f.agent);
    startup.startQuery = () => ResultAsync.fromSafePromise(gate).andThen(original);
    const next = f.nextQuery();
    const admitted = f.agent.deliverInboxMessage("initial", ["initial"], content);
    (await f.agent.abortOperation())._unsafeUnwrap();
    release();
    await next;
    expect((await admitted).isErr()).toBe(true);
    f.query.exit();
    f.query.endOutput();
    await f.agent.closeExtensions();
    expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
    expect(f.state.deliveries.initial).toBeUndefined();
  } finally {
    release();
    await dispose(f);
  }
});

it.each([false, true])(
  "a UUID-less error fails rather than answers initial input (during startup=%s)",
  async (startup) => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = new ComposedClaudeFixture(startup ? gate : Promise.resolve());
    try {
      (await f.attach())._unsafeUnwrap();
      const next = f.nextQuery();
      const admitted = f.agent.deliverInboxMessage("initial", ["initial"], content);
      await next;
      if (!startup) {
        expect((await admitted).isOk()).toBe(true);
        const input = (await f.query.input.next()).value;
        if (input === undefined) throw new Error("Missing input");
        f.receipt(input);
      }
      await f.query.emitUnscheduled({
        ...rootResult,
        subtype: "error_during_execution",
        is_error: true,
        errors: ["failed"],
      } as SDKMessage);
      expect(f.query.closeRequested).toBe(true);
      f.query.exit();
      f.query.endOutput();
      release();
      expect((await admitted).isErr()).toBe(startup);
      await f.agent.closeExtensions();
      expect(
        f.frames.some(
          (frame) =>
            frame.type === "runtime.event" &&
            frame.event.type === "operation_finished" &&
            frame.event.outcome === "completed",
        ),
      ).toBe(false);
      if (startup) expect(f.state.deliveries.initial).toBeUndefined();
    } finally {
      release();
      await dispose(f);
    }
  },
);

it("an unrelated startup acknowledgment cannot finish an admitted compaction", async () => {
  let release = () => {};
  const account = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = new ComposedClaudeFixture(account);
  try {
    (await f.attach())._unsafeUnwrap();
    const next = f.nextQuery();
    const compacting = f.agent.compact(undefined, "compact");
    await next;
    await f.query.emitUnscheduled({ ...rootResult, num_turns: 0 } as SDKMessage);
    expect(f.query.closeRequested).toBe(false);
    release();
    const command = (await f.query.input.next()).value;
    if (command === undefined) throw new Error("Missing compaction command");
    f.receipt(command);
    f.append({
      type: "system",
      subtype: "compact_boundary",
      uuid: "boundary",
      compactMetadata: { trigger: "manual" },
    });
    f.append({
      type: "user",
      uuid: "summary",
      parentUuid: "boundary",
      isCompactSummary: true,
      message: { role: "user", content: "summary" },
    });
    await f.query.emitUnscheduled(resultFor(command, true));
    expect(f.query.closeRequested).toBe(true);
    f.query.exit();
    f.query.endOutput();
    expect((await compacting).isOk()).toBe(true);
    expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
  } finally {
    release();
    await dispose(f);
  }
});

it("a cancelled query's late initialization cannot open steering on a newer initializing operation", async () => {
  let releaseAccount = () => {};
  let releaseModels = () => {};
  const account = new Promise<void>((resolve) => {
    releaseAccount = resolve;
  });
  const models = new Promise<void>((resolve) => {
    releaseModels = resolve;
  });
  const f = new ComposedClaudeFixture(account);
  try {
    (await f.attach())._unsafeUnwrap();
    const firstQuery = f.nextQuery();
    const first = f.agent.deliverInboxMessage("first", ["first"], content);
    const old = await firstQuery;
    const abort = f.agent.abortOperation();
    old.exit();
    old.endOutput();
    (await abort)._unsafeUnwrap();
    const next = f.nextQuery();
    const second = f.agent.deliverInboxMessage("second", ["second"], content);
    const current = await next;
    const supported = current.supportedModels.bind(current);
    current.supportedModels = async () => {
      await models;
      return supported();
    };
    releaseAccount();
    expect((await first).isErr()).toBe(true);
    expect((await f.agent.deliverInboxMessage("steer", ["steer"], content)).isErr()).toBe(true);
    expect(f.state.deliveries.first).toBeUndefined();
    expect(f.state.deliveries.steer).toBeUndefined();
    releaseModels();
    expect((await second).isOk()).toBe(true);
    const input = (await current.input.next()).value;
    if (input === undefined) throw new Error("Missing newer input");
    f.receipt(input);
    await current.emitUnscheduled(resultFor(input, true));
    expect(current.closeRequested).toBe(true);
    current.exit();
    current.endOutput();
    await f.agent.closeExtensions();
    expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
  } finally {
    releaseAccount();
    releaseModels();
    await dispose(f);
  }
});

it("a capped echo cannot settle an omitted initial input without its durable receipt", async () => {
  const f = new ComposedClaudeFixture();
  try {
    (await f.attach())._unsafeUnwrap();
    (await f.agent.deliverInboxMessage("initial", ["initial"], content))._unsafeUnwrap();
    const initial = (await f.query.input.next()).value;
    if (initial === undefined) throw new Error("Missing initial");
    const uuids: string[] = [];
    for (let i = 0; i < 65; i++) {
      const id = `steer-${i}`;
      (await f.agent.deliverInboxMessage(id, [id], content))._unsafeUnwrap();
      const input = (await f.query.input.next()).value;
      if (input?.uuid === undefined) throw new Error("Missing steer");
      f.receipt(input);
      uuids.push(input.uuid);
    }
    await f.query.emitUnscheduled({
      ...rootResult,
      user_message_uuids: uuids.slice(-64),
    } as SDKMessage);
    expect(f.query.closeRequested).toBe(false);
    f.receipt(initial);
    await f.query.emitUnscheduled({
      ...rootResult,
      user_message_uuids: [initial.uuid, uuids[0]],
    } as SDKMessage);
    expect(f.query.closeRequested).toBe(true);
  } finally {
    await dispose(f);
  }
});

it.each([undefined, 429])(
  "UUID-less failure preserves queued steering before failed terminal (status=%s)",
  async (api_error_status) => {
    const f = new ComposedClaudeFixture();
    try {
      (await f.attach())._unsafeUnwrap();
      (await f.agent.deliverInboxMessage("initial", ["initial"], content))._unsafeUnwrap();
      const initial = (await f.query.input.next()).value;
      if (initial === undefined) throw new Error("Missing initial");
      f.receipt(initial);
      (await f.agent.deliverInboxMessage("steer", ["steer"], content))._unsafeUnwrap();
      const steer = (await f.query.input.next()).value;
      if (steer === undefined) throw new Error("Missing steer");
      f.receipt(steer);
      await f.query.emitUnscheduled({
        ...rootResult,
        is_error: true,
        api_error_status,
        queued_turn_count: 1,
      } as SDKMessage);
      expect(f.query.closeRequested).toBe(false);
      expect(f.agent.gateView().activity).toBe("busy");
      await f.query.emitUnscheduled(resultFor(steer, true));
      expect(f.query.closeRequested).toBe(true);
      f.query.exit();
      f.query.endOutput();
      await f.agent.closeExtensions();
      expect(
        f.history.view.find(
          (record) => record.type === "event" && record.eventType === "claude.operation_finished",
        ),
      ).toMatchObject({ overflow: { outcome: "failed" } });
    } finally {
      await dispose(f);
    }
  },
);

it.each([false, true])(
  "startup failure drains as failed when account resolves before process exit (compact=%s)",
  async (compact) => {
    let release = () => {};
    const account = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = new ComposedClaudeFixture(account);
    try {
      (await f.attach())._unsafeUnwrap();
      const next = f.nextQuery();
      const operation = compact
        ? f.agent.compact(undefined, "compact")
        : f.agent.deliverInboxMessage("initial", ["initial"], content);
      await next;
      const initialized = compact
        ? (f.agent as unknown as { compaction: { initialized: Promise<void> } }).compaction
            .initialized
        : operation;
      await f.query.emitUnscheduled({
        ...rootResult,
        subtype: "error_during_execution",
        is_error: true,
        errors: ["native startup failure"],
      } as SDKMessage);
      expect(f.query.closeRequested).toBe(true);
      const fatal = new Promise<void>((resolve) => {
        f.agent.subscribe(() => {
          if (f.agent.getHealth().status === "failed") resolve();
        });
      });
      release();
      await Promise.race([initialized, fatal]);
      expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "busy" });
      f.query.exit();
      f.query.endOutput();
      expect((await operation).isErr()).toBe(true);
      await f.agent.closeExtensions();
      expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
      expect(
        f.history.view.find(
          (record) => record.type === "event" && record.eventType === "claude.operation_finished",
        ),
      ).toMatchObject({ overflow: { outcome: "failed" } });
    } finally {
      release();
      await dispose(f);
    }
  },
);

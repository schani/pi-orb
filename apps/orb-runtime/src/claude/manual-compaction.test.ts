import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { projectDisplayRecord } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { expect, it } from "vitest";
import { planBootNotification } from "../pi/boot-notification.ts";
import {
  ComposedClaudeFixture,
  nativeHook,
  nativeHookResponse,
  rootResult,
} from "../testkit/claude-composed.ts";
import { claudeBootEntries } from "./boot-notification.ts";

const task = new NoSimulationTask("claude-compact-test", false);
function gate() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function summary(f: ComposedClaudeFixture) {
  f.append({
    type: "system",
    subtype: "compact_boundary",
    uuid: "boundary",
    content: "Conversation compacted",
    compactMetadata: { trigger: "manual" },
  });
  f.append({
    type: "user",
    uuid: "summary",
    parentUuid: "boundary",
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
    message: { role: "user", content: "canonical native summary" },
  });
}

it("claims native compaction before initialization, freezes the published frontier, and commits the summary before idle", async () => {
  const f = new ComposedClaudeFixture();
  try {
    f.append({ type: "assistant", uuid: "before", message: { content: "before" } });
    await f.attach();
    const next = f.nextQuery();
    const compacting = f.agent.compact("Keep private decisions", "compact-op");
    expect(f.agent.gateView()).toMatchObject({ activity: "busy", activeOperationId: "compact-op" });
    expect(f.agent.snapshot()._unsafeUnwrap()).toMatchObject({
      work: "compaction",
      compactionAfterId: "before",
    });
    const query = await next;
    const command = await query.input.next();
    expect(command).toMatchObject({
      done: false,
      value: {
        type: "user",
        message: { role: "user", content: "/compact Keep private decisions" },
      },
    });
    expect(command.value).not.toHaveProperty("client_composed");
    expect(f.journal().deliveries).toEqual({});
    expect(f.agent.canCompact().isErr()).toBe(true);
    expect(
      (
        await f.agent.changeSettings({
          type: "set_model",
          model: { provider: "claude", id: "opus" },
        })
      ).isErr(),
    ).toBe(true);
    expect(
      (
        await f.agent.deliverInboxMessage(
          "waiting",
          ["waiting"],
          [{ type: "text", text: "queued human" }],
        )
      ).isErr(),
    ).toBe(true);
    f.agent.appendAlert({ v: 1, requestId: "alert", message: "alert" });
    expect(f.agent.snapshot()._unsafeUnwrap().compactionAfterId).toBe("before");
    f.receipt(command.value);
    await query.emit(task, {
      type: "system",
      subtype: "status",
      status: "compacting",
    } as SDKMessage);
    summary(f);
    await query.emit(task, {
      type: "system",
      subtype: "status",
      status: null,
      compact_result: "success",
    } as SDKMessage);
    expect(f.agent.gateView().activity).toBe("busy");
    await query.emit(task, rootResult);
    query.exit();
    expect(f.agent.gateView().activity).toBe("busy");
    query.endOutput();
    expect((await compacting).isOk()).toBe(true);
    expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
    const records = f.agent.snapshot()._unsafeUnwrap().records;
    expect(records.find((record) => record.id === "summary")).toMatchObject({
      type: "compaction",
      summary: [{ type: "text", text: "canonical native summary" }],
    });
    expect(records.filter((record) => record.type === "message" && record.role === "user")).toEqual(
      [],
    );
    expect(JSON.stringify(records.map(projectDisplayRecord))).not.toContain("private decisions");
    const started = f.frames.find(
      (frame) =>
        frame.type === "runtime.event" &&
        frame.event.type === "status" &&
        frame.event.activity === "busy",
    );
    expect(started).toMatchObject({ event: { work: "compaction", compactionAfterId: "before" } });
    expect(
      f.frames.filter(
        (frame) => frame.type === "runtime.event" && frame.event.type === "operation_finished",
      ),
    ).toHaveLength(1);
    const delivered = await f.agent.deliverInboxMessage(
      "waiting",
      ["waiting"],
      [{ type: "text", text: "queued human" }],
    );
    expect(delivered.isOk()).toBe(true);
    const input = await f.query.input.next();
    f.receipt(input.value!);
    await f.query.emit(task, rootResult);
    f.query.exit();
    f.query.endOutput();
    await f.agent.closeExtensions();
    expect(
      f.history.view.filter(
        (record) => record.type === "message" && record.inboxMessageIds?.includes("waiting"),
      ),
    ).toHaveLength(1);
  } finally {
    f.dispose();
  }
});

it.each(["failed", "aborted"] as const)(
  "persists one typed %s compaction outcome without an answer or human command",
  async (outcome) => {
    const f = new ComposedClaudeFixture();
    try {
      await f.attach();
      const next = f.nextQuery();
      const compacting = f.agent.compact(undefined, "compact-op");
      const query = await next;
      const command = await query.input.next();
      f.receipt(command.value!);
      let aborting: ReturnType<typeof f.agent.abortOperation> | undefined;
      if (outcome === "aborted") aborting = f.agent.abortOperation();
      else
        await query.emit(task, {
          type: "system",
          subtype: "status",
          status: null,
          compact_result: "failed",
          compact_error: "private provider error content",
        } as SDKMessage);
      await query.emit(task, rootResult);
      query.exit();
      query.endOutput();
      await aborting;
      expect((await compacting).isErr()).toBe(true);
      const snapshot = f.agent.snapshot()._unsafeUnwrap();
      const events = snapshot.records.filter(
        (record) => record.type === "event" && record.compaction !== undefined,
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ compaction: { operationId: "compact-op", outcome } });
      expect(projectDisplayRecord(events[0]!)).toMatchObject({
        eventType: "agent.compaction",
        compactionOutcome: outcome,
        content: [
          {
            type: "text",
            text:
              outcome === "aborted"
                ? "Context compaction cancelled."
                : "Context compaction failed.",
          },
        ],
      });
      expect(JSON.stringify(snapshot.records)).not.toContain("private provider error");
      expect(f.agent.gateView().activity).toBe("idle");
    } finally {
      f.dispose();
    }
  },
);

it.each(["completed", "failed", "aborted"] as const)(
  "%s native compaction cannot settle interrupted root work or renew its boot budget",
  async (outcome) => {
    const f = new ComposedClaudeFixture();
    try {
      f.append({ type: "user", uuid: "human", message: { role: "user", content: "work" } });
      await f.attach();
      for (const id of ["a", "b", "c"])
        f.history
          .appendPlatform({
            id,
            parentId: f.history.view.at(-1)?.id ?? null,
            timestamp: f.state.timestamp,
            type: "event",
            eventType: "pi-orb.turn-resume",
            overflow: { runtimeInstanceId: id, executionId: "old", incarnation: "0" },
          })
          ._unsafeUnwrap();
      const next = f.nextQuery();
      const compacting = f.agent.compact("Private instructions", "compact-op");
      const query = await next;
      const command = await query.input.next();
      f.receipt(command.value!);
      f.append({
        type: "user",
        uuid: "stdout",
        parentUuid: command.value!.uuid,
        message: {
          role: "user",
          content: "<local-command-stdout>Compacted</local-command-stdout>",
        },
      });
      f.append({
        type: "user",
        uuid: "meta",
        isMeta: true,
        message: { role: "user", content: "metadata" },
      });
      let aborting: ReturnType<typeof f.agent.abortOperation> | undefined;
      if (outcome === "completed") summary(f);
      else if (outcome === "aborted") aborting = f.agent.abortOperation();
      else
        await query.emit(task, {
          type: "system",
          subtype: "status",
          status: null,
          compact_result: "failed",
        } as SDKMessage);
      await query.emit(task, rootResult);
      query.exit();
      query.endOutput();
      await aborting;
      expect((await compacting).isOk()).toBe(outcome === "completed");
      const entries = claudeBootEntries(f.history.view);
      expect(
        planBootNotification(entries, entries, {
          runtimeInstanceId: "replacement",
          executionId: "new",
          incarnation: "1",
        }),
      ).toMatchObject({
        triggerTurn: false,
        marker: { customType: "pi-orb.turn-resume-declined" },
      });
    } finally {
      f.dispose();
    }
  },
);

it("cancels during SDK initialization without ever enqueueing the native command", async () => {
  const ready = gate();
  const f = new ComposedClaudeFixture(ready.promise);
  try {
    await f.attach();
    const next = f.nextQuery();
    const compacting = f.agent.compact(undefined, "compact-op");
    const query = await next;
    const aborting = f.agent.abortOperation();
    expect(f.agent.gateView().activity).toBe("busy");
    ready.release();
    query.exit();
    query.endOutput();
    await aborting;
    expect((await compacting).isErr()).toBe(true);
    expect(await query.input.next()).toMatchObject({ done: true });
    expect(
      f.history.view.filter(
        (record) => record.type === "event" && record.compaction?.outcome === "aborted",
      ),
    ).toHaveLength(1);
    expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
  } finally {
    f.dispose();
  }
});

it("holds child/hook ownership and fails busy on missing durable summary or persistence failure", async () => {
  const f = new ComposedClaudeFixture();
  try {
    await f.attach();
    const next = f.nextQuery();
    const compacting = f.agent.compact(undefined, "compact-op");
    const query = await next;
    await query.input.next();
    await query.emit(task, nativeHook("hook"));
    await query.emit(task, rootResult);
    expect(query.closeRequested).toBe(false);
    expect(f.agent.canCompact().isErr()).toBe(true);
    await query.emit(task, nativeHookResponse(nativeHook("hook")));
    query.exit();
    query.endOutput();
    expect((await compacting).isErr()).toBe(true);
    expect(f.agent.getHealth()).toMatchObject({
      status: "failed",
      error: { code: "claude_compaction_summary_missing" },
    });
    expect(f.agent.gateView().activity).toBe("busy");
    expect(f.frames.filter((frame) => frame.type === "server.error")).toHaveLength(1);
    expect(f.frames.find((frame) => frame.type === "server.error")).toMatchObject({
      error: { code: "internal", retryable: false },
    });
  } finally {
    f.dispose();
  }
});

it("tears down the query even when public interrupt accepts a still-queued compact command", async () => {
  const f = new ComposedClaudeFixture();
  try {
    await f.attach();
    const next = f.nextQuery();
    const compacting = f.agent.compact(undefined, "compact-op");
    const query = await next;
    const command = await query.input.next();
    expect(command.value?.uuid).toBe(f.journal().compaction?.commandUuid);
    const aborting = f.agent.abortOperation();
    expect(query.options.abortController?.signal.aborted).toBe(true);
    expect(f.agent.gateView().activity).toBe("busy");
    query.exit();
    expect(f.agent.gateView().activity).toBe("busy");
    query.endOutput();
    expect((await aborting).isOk()).toBe(true);
    expect((await compacting).isErr()).toBe(true);
    expect(
      f.history.view.filter(
        (record) => record.type === "event" && record.compaction?.outcome === "aborted",
      ),
    ).toHaveLength(1);
  } finally {
    f.dispose();
  }
});

it("recovers an interrupted manual compact journal without replaying the command", async () => {
  const f = new ComposedClaudeFixture();
  try {
    f.state.compaction = { operationId: "previous-compact", commandUuid: "previous-command" };
    f.history
      .correlate("previous-command", {
        messageIds: [],
        operationId: "previous-compact",
        compaction: true,
      })
      ._unsafeUnwrap();
    f.append({ type: "user", uuid: "previous-command", message: { content: "/compact" } });
    expect((await f.attach()).isOk()).toBe(true);
    expect(
      f.history.view.filter(
        (record) =>
          record.type === "event" && record.compaction?.operationId === "previous-compact",
      ),
    ).toHaveLength(1);
    expect(f.journal()).not.toHaveProperty("compaction");
    expect(f.queries).toHaveLength(1);
    expect(await f.query.input.next()).toMatchObject({ done: true });
  } finally {
    f.dispose();
  }
});

it("never releases the compaction gate after a native fsync failure", async () => {
  const f = new ComposedClaudeFixture();
  try {
    await f.attach();
    const next = f.nextQuery();
    const compacting = f.agent.compact(undefined, "compact-op");
    const query = await next;
    await query.input.next();
    summary(f);
    f.failSync = true;
    await query.emit(task, rootResult);
    query.exit();
    query.endOutput();
    await f.agent.closeExtensions();
    expect((await compacting).isErr()).toBe(true);
    expect(f.agent.getHealth()).toMatchObject({ status: "failed" });
    expect(f.agent.gateView().activity).toBe("busy");
    expect(
      f.frames.some(
        (frame) => frame.type === "runtime.event" && frame.event.type === "operation_finished",
      ),
    ).toBe(false);
    expect(f.frames.filter((frame) => frame.type === "server.error")).toHaveLength(1);
  } finally {
    f.dispose();
  }
});

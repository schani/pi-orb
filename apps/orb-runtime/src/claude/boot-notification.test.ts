import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { HistoryRecord, OrbBootContext } from "@pi-orb/protocol";
import { describe, expect, it } from "vitest";
import { ComposedClaudeFixture, rootResult } from "../testkit/claude-composed.ts";
import {
  classifyPassiveBootResult,
  claudeBootEntries,
  pendingBootContext,
} from "./boot-notification.ts";
import { planBootNotification } from "./boot-policy.ts";
import { ClaudeHistory } from "./history.ts";

const identity = { runtimeInstanceId: "new", executionId: "host-2", incarnation: "1" };
const base = { parentId: null, timestamp: "2026-10-06T00:00:00Z", overflow: {} };
const human: HistoryRecord = {
  ...base,
  id: "human",
  type: "message",
  role: "user",
  content: [{ type: "text", text: "work" }],
};
const assistant: HistoryRecord = {
  ...base,
  id: "assistant",
  type: "message",
  role: "assistant",
  content: [{ type: "tool_call", callId: "call", name: "Bash", arguments: {} }],
  finishReason: "tool_use",
};
const boot = (id: string, customType = "pi-orb.turn-resume"): HistoryRecord => ({
  ...base,
  id,
  type: "event",
  eventType: customType,
  custom: { customType, display: true },
  content: [{ type: "text", text: "continue" }],
  overflow: { runtimeInstanceId: id, executionId: "host-1", incarnation: "1", reason: "resumed" },
});
const plan = (records: HistoryRecord[], wake: OrbBootContext | null = null) => {
  const entries = claudeBootEntries(records);
  return planBootNotification(entries, entries, identity, wake);
};

describe("Claude uses Pi's boot decision", () => {
  it("keeps fresh baselines silent and distinguishes host from runtime restart", () => {
    expect(plan([])).toEqual({ kind: "baseline", identity });
    expect(
      plan([
        human,
        boot("old", "pi-orb.boot"),
        { ...assistant, content: [{ type: "text", text: "done" }], finishReason: "end_turn" },
      ]),
    ).toMatchObject({
      kind: "message",
      triggerTurn: false,
      marker: { customType: "pi-orb.host-restarted", details: { reason: "host_restarted" } },
    });
  });
  it("uses runtime-only wording for unchanged execution identity", () => {
    const entries = claudeBootEntries([
      human,
      {
        ...boot("old", "pi-orb.boot"),
        overflow: {
          runtimeInstanceId: "old",
          executionId: identity.executionId,
          incarnation: identity.incarnation,
        },
      },
    ]);
    const decision = planBootNotification(entries, entries, identity);
    expect(decision).toMatchObject({
      kind: "message",
      marker: { content: expect.stringContaining("Other processes may still be running") },
    });
    expect(decision).not.toMatchObject({
      marker: { content: expect.stringContaining("All processes running before") },
    });
  });
  it("classifies native dangling calls, tool results and unanswered input", () => {
    expect(plan([human])).toMatchObject({
      marker: { details: { shape: "unanswered_user_message" } },
    });
    expect(plan([human, assistant])).toMatchObject({
      marker: { details: { shape: "dangling_tool_calls" } },
    });
    expect(
      plan([
        human,
        assistant,
        {
          ...base,
          id: "tool",
          type: "message",
          role: "tool",
          content: [{ type: "tool_result", callId: "call", content: [] }],
        },
      ]),
    ).toMatchObject({ marker: { details: { shape: "trailing_tool_result" } } });
  });
  it("counts journal claims across compaction and only human input resets the budget", () => {
    const exhausted = [
      human,
      assistant,
      boot("a"),
      boot("b"),
      boot("c"),
      { ...base, id: "compact", type: "compaction" as const, summary: [] },
    ];
    expect(plan(exhausted)).toMatchObject({
      triggerTurn: false,
      marker: { customType: "pi-orb.turn-resume-declined" },
    });
    const system: HistoryRecord = {
      ...base,
      id: "system",
      type: "event",
      eventType: "claude.platform_message",
      content: [{ type: "text", text: "upload" }],
    };
    expect(plan([...exhausted, system])).toMatchObject({ triggerTurn: false });
    const peer: HistoryRecord = {
      ...system,
      id: "peer",
      eventType: "orb.message",
      sender: { orbId: "11111111-1111-4111-8111-111111111111" },
      inboxMessageIds: ["peer"],
    };
    expect(plan([...exhausted, peer])).toMatchObject({ triggerTurn: false });
    expect(plan([...exhausted, { ...human, id: "next-human" }])).toMatchObject({
      triggerTurn: true,
      marker: { details: { reason: "resumed" } },
    });
  });
  it("native compaction summaries and meta input never renew automatic-turn authority", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-boot-summary-"));
    try {
      const path = join(dir, "native.jsonl");
      const history = new ClaudeHistory(dir, "session", base.timestamp);
      history.appendPlatform(human)._unsafeUnwrap();
      for (const id of ["a", "b", "c"]) history.appendPlatform(boot(id))._unsafeUnwrap();
      writeFileSync(
        path,
        `${JSON.stringify({ type: "user", uuid: "summary", isCompactSummary: true, message: { role: "user", content: "Summary of previous work" } })}\n${JSON.stringify({ type: "user", uuid: "meta", isMeta: true, message: { role: "user", content: "Native metadata" } })}\n`,
      );
      expect(plan([...history.scan(path)._unsafeUnwrap()])).toMatchObject({
        triggerTurn: false,
        marker: { customType: "pi-orb.turn-resume-declined" },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("projects consumed human authority at its attachment, never at the appended tail", () => {
    const attachment: HistoryRecord = {
      ...base,
      id: "attachment",
      type: "event",
      eventType: "claude.attachment",
    };
    const receipt: HistoryRecord = {
      ...base,
      id: "input",
      type: "event",
      eventType: "claude.input_receipt",
      overflow: { attachmentId: attachment.id, inputKind: "human" },
    };
    expect(claudeBootEntries([attachment, assistant, receipt])).toMatchObject([
      { id: "input", message: { role: "user" } },
      { id: "assistant" },
    ]);
    expect(plan([attachment, assistant, boot("a"), boot("b"), boot("c"), receipt])).toMatchObject({
      triggerTurn: false,
      marker: { customType: "pi-orb.turn-resume-declined" },
    });
    expect(
      plan([attachment, { ...assistant, content: [], finishReason: "end_turn" }, receipt]),
    ).toMatchObject({
      marker: { customType: "pi-orb.host-restarted" },
    });
  });
  it("does not resume explicitly aborted or failed operations", () => {
    for (const outcome of ["aborted", "failed"]) {
      const terminal: HistoryRecord = {
        ...base,
        id: "terminal",
        type: "event",
        eventType: "claude.operation_finished",
        overflow: { outcome },
      };
      expect(plan([human, assistant, terminal])).toMatchObject({
        marker: { customType: "pi-orb.host-restarted" },
      });
      expect(plan([human, assistant, terminal])).not.toMatchObject({
        marker: { details: { reason: "resumed" } },
      });
    }
  });
  it("deduplicates the same runtime and combined sleep notice from journal identity", () => {
    expect(plan([human, { ...boot("old"), overflow: { ...identity } }])).toEqual({ kind: "none" });
    const wake: OrbBootContext = {
      messageId: "sleep",
      messageIds: ["sleep"],
      content: [{ type: "text", text: "Wake now." }],
      system: { kind: "sleep_wake", sleepUntil: base.timestamp },
    };
    expect(plan([human], wake)).toMatchObject({
      marker: { customType: "pi-orb.sleep-wake", details: { messageIds: ["sleep"] } },
    });
    expect(
      plan(
        [
          human,
          {
            ...boot("wake", "pi-orb.sleep-wake"),
            overflow: { ...identity, messageIds: ["sleep"] },
          },
        ],
        wake,
      ),
    ).toEqual({ kind: "none" });
  });
});

const passive: HistoryRecord = {
  ...boot("passive", "pi-orb.host-restarted"),
  type: "event",
  eventType: "pi-orb.host-restarted",
  overflow: {
    runtimeInstanceId: "before",
    executionId: "host-1",
    incarnation: "1",
    reason: "host_restarted",
  },
};
const passiveReceipt: HistoryRecord = {
  ...base,
  id: "passive-input",
  type: "event",
  eventType: "claude.boot_receipt",
  overflow: { operationId: passive.id },
};
it("projects passive host notices as metadata, never an unanswered input or attempt", () => {
  expect(claudeBootEntries([passive])).toMatchObject([
    { type: "custom", customType: "pi-orb.host-restarted" },
  ]);
  const records = [human, { ...assistant, content: [], finishReason: "end_turn" }, passive];
  expect(plan(records)).toMatchObject({
    triggerTurn: false,
    marker: { details: { reason: "host_restarted" } },
  });
  expect(plan([...records, assistant, boot("a"), boot("b")])).toMatchObject({ triggerTurn: true });
});
it("derives pending passive context only until its native receipt is durable", () => {
  expect(pendingBootContext([passive, boot("automatic")])).toEqual([passive]);
  expect(pendingBootContext([passive, passiveReceipt])).toEqual([]);
  expect(pendingBootContext([passiveReceipt, passive])).toEqual([]);
});
it("classifies only known passive acknowledgements and requires their durable receipts", () => {
  const result = {
    subtype: "success",
    is_error: false,
    num_turns: 0,
    user_message_uuids: [passiveReceipt.id],
  };
  const classify = (view: readonly HistoryRecord[], message = result) =>
    classifyPassiveBootResult(
      {
        view,
        correlation: (id) =>
          id === passiveReceipt.id
            ? { messageIds: [], boot: true, operationId: passive.id }
            : undefined,
      },
      message,
    );
  expect(classify([passive, passiveReceipt])).toBe("durable");
  expect(classify([passive])).toBe("pending_receipt");
  expect(
    classify([passive, { ...passiveReceipt, overflow: { operationId: "another-marker" } }]),
  ).toBe("pending_receipt");
  expect(classify([boot(passive.id), passiveReceipt])).toBe("not_passive");
  expect(classify([passive, passiveReceipt], { ...result, num_turns: 1 })).toBe("not_passive");
  expect(classify([passive, passiveReceipt], { ...result, is_error: true })).toBe("not_passive");
  expect(classify([passive, passiveReceipt], { ...result, user_message_uuids: [] })).toBe(
    "not_passive",
  );
  expect(
    classify([passive, passiveReceipt], {
      ...result,
      user_message_uuids: [passiveReceipt.id, "human"],
    }),
  ).toBe("pending_receipt");
  expect(
    classifyPassiveBootResult(
      { view: [passive, passiveReceipt], correlation: () => undefined },
      result,
    ),
  ).toBe("not_passive");
});

async function settledFixture() {
  const f = new ComposedClaudeFixture();
  f.history
    .appendPlatform({
      ...boot("old", "pi-orb.boot"),
      overflow: { runtimeInstanceId: "old", executionId: "old-host", incarnation: "0" },
    })
    ._unsafeUnwrap();
  f.append({ type: "user", uuid: "human", message: { role: "user", content: "work" } });
  f.append({
    type: "assistant",
    uuid: "done",
    message: { role: "assistant", content: "done", stop_reason: "end_turn" },
  });
  expect(
    (await f.agent.attachSession(f.state, f.history, f.configDir, "commit", null)).isOk(),
  ).toBe(true);
  return f;
}
async function queuedInput(f: ComposedClaudeFixture) {
  const entry = await f.query.input.next();
  if (entry.done || entry.value.uuid === undefined) throw new Error("Native input missing.");
  return { ...entry.value, uuid: entry.value.uuid };
}

it("settled boot stays idle, then queues context once before the next real input", async () => {
  const f = await settledFixture();
  try {
    expect(f.queries).toHaveLength(1);
    expect(f.agent.getHealth()).toMatchObject({
      status: "ready",
      activity: "idle",
      turnResume: { outcome: "notified_restart" },
    });
    const marker = pendingBootContext(f.history.view)[0];
    expect(marker).toBeDefined();
    expect(marker?.overflow.operationId).toBeUndefined();
    expect(
      (await f.agent.submitMessage([{ type: "text", text: "new task" }], "legitimate")).isOk(),
    ).toBe(true);
    const context = await queuedInput(f);
    const human = await queuedInput(f);
    expect(context).toMatchObject({ isSynthetic: true, shouldQuery: false });
    expect(context.origin).toBeUndefined();
    expect(f.history.correlation(context.uuid)).toMatchObject({
      boot: true,
      operationId: marker?.id,
    });
    expect(human).toMatchObject({
      origin: { kind: "human" },
      message: { content: [{ type: "text", text: "new task" }] },
    });
    f.receipt(context);
    f.receipt(human);
    await f.query.emitUnscheduled({
      ...rootResult,
      num_turns: 0,
      queued_turn_count: 0,
      user_message_uuid: context.uuid,
      user_message_uuids: [context.uuid],
    } as SDKMessage);
    expect(f.agent.gateView()).toMatchObject({ activity: "busy", activeOperationId: "legitimate" });
    expect(f.query.closeRequested).toBe(false);
    await f.query.emitUnscheduled({
      ...rootResult,
      user_message_uuid: human.uuid,
      user_message_uuids: [human.uuid],
    } as SDKMessage);
    f.query.exit();
    f.query.endOutput();
    await f.agent.closeExtensions();
    expect(pendingBootContext(f.history.view)).toEqual([]);
    expect((await f.agent.submitMessage([{ type: "text", text: "another" }], "next")).isOk()).toBe(
      true,
    );
    expect(await queuedInput(f)).toMatchObject({
      origin: { kind: "human" },
      message: { content: [{ type: "text", text: "another" }] },
    });
    const reloaded = new ClaudeHistory(
      join(f.dir, "claude"),
      f.state.id,
      f.state.timestamp,
      f.files,
    );
    expect(pendingBootContext(reloaded.scan(f.nativePath)._unsafeUnwrap())).toEqual([]);
  } finally {
    f.query.exit();
    f.query.endOutput();
    f.dispose();
  }
});
it("fails closed when passive input correlation cannot be committed", async () => {
  const f = await settledFixture();
  try {
    f.failCommit = true;
    expect(
      (await f.agent.submitMessage([{ type: "text", text: "new task" }], "legitimate")).isErr(),
    ).toBe(true);
    expect(f.agent.getHealth()).toMatchObject({ status: "failed" });
    expect(pendingBootContext(f.history.view)).toHaveLength(1);
    f.query.exit();
    f.query.endOutput();
    await f.agent.closeExtensions();
    expect(await f.query.input.next()).toMatchObject({ done: true });
  } finally {
    f.query.exit();
    f.query.endOutput();
    f.dispose();
  }
});

it("retains proven host loss through a later runtime-only passive boot", () => {
  const records = [human, { ...assistant, content: [], finishReason: "end_turn" }, passive];
  const runtimeOnly = planBootNotification(claudeBootEntries(records), claudeBootEntries(records), {
    ...identity,
    executionId: "host-1",
  });
  expect(runtimeOnly).toMatchObject({
    triggerTurn: false,
    marker: { details: { reason: "runtime_restarted" } },
  });
  if (runtimeOnly.kind !== "message") throw new Error("Expected runtime notice.");
  const second: HistoryRecord = {
    ...passive,
    id: "runtime-only",
    content: [{ type: "text", text: runtimeOnly.marker.content }],
    overflow: {
      runtimeInstanceId: identity.runtimeInstanceId,
      executionId: "host-1",
      incarnation: identity.incarnation,
      reason: "runtime_restarted",
    },
  };
  expect(pendingBootContext([...records, second])).toEqual([passive, second]);
  expect(pendingBootContext([...records, second, passiveReceipt])).toEqual([second]);
});

it.each(["commit", "sync"] as const)(
  "passive result cannot acknowledge a failed native receipt %s",
  async (failure) => {
    const f = await settledFixture();
    try {
      expect(
        (await f.agent.submitMessage([{ type: "text", text: "new task" }], "legitimate")).isOk(),
      ).toBe(true);
      const context = await queuedInput(f);
      const human = await queuedInput(f);
      f.receipt(context);
      f.receipt(human);
      const beforeAck = new ClaudeHistory(
        join(f.dir, "claude"),
        f.state.id,
        f.state.timestamp,
        f.files,
      );
      expect(pendingBootContext(beforeAck.scan(f.nativePath)._unsafeUnwrap())).toEqual([]);
      if (failure === "commit") f.failCommit = true;
      else f.failSync = true;
      await f.query.emitUnscheduled({
        ...rootResult,
        num_turns: 0,
        user_message_uuid: context.uuid,
        user_message_uuids: [context.uuid],
      } as SDKMessage);
      expect(f.agent.getHealth()).toMatchObject({
        status: "failed",
        error: { code: "history_unavailable" },
      });
    } finally {
      f.query.exit();
      f.query.endOutput();
      f.dispose();
    }
  },
);

it("fails closed when a known passive result arrives before its native receipt", async () => {
  const f = await settledFixture();
  try {
    expect(
      (await f.agent.submitMessage([{ type: "text", text: "new task" }], "legitimate")).isOk(),
    ).toBe(true);
    const context = await queuedInput(f);
    const human = await queuedInput(f);
    f.receipt(human);
    await f.query.emitUnscheduled({
      ...rootResult,
      num_turns: 0,
      queued_turn_count: 0,
      user_message_uuid: context.uuid,
      user_message_uuids: [context.uuid],
    } as SDKMessage);
    expect(f.agent.getHealth()).toMatchObject({
      status: "failed",
      error: { code: "claude_boot_receipt_missing" },
    });
    expect(pendingBootContext(f.history.view)).toHaveLength(1);
    expect(
      f.history.view.filter(
        (record) => record.type === "event" && record.eventType === "claude.operation_finished",
      ),
    ).toEqual([]);
  } finally {
    f.query.exit();
    f.query.endOutput();
    f.dispose();
  }
});

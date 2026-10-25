import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { HistoryRecord, OrbBootContext } from "@pi-orb/protocol";
import { describe, expect, it } from "vitest";
import { ComposedClaudeFixture, rootResult } from "../testkit/claude-composed.ts";
import { claudeBootEntries, pendingBootContext } from "./boot-notification.ts";
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

describe("passive boot context consumption", () => {
  const marker = boot("host-marker", "pi-orb.host-restarted");
  const receipt: HistoryRecord = {
    ...base,
    id: "queued-boot-input",
    type: "event",
    eventType: "claude.input_receipt",
    overflow: { operationId: marker.id, inputKind: "boot" },
  };

  it.each([1, 2])("acknowledges %i consumed boot inputs for the same operation", (count) => {
    const receipts = Array.from({ length: count }, (_, index) => ({
      ...receipt,
      id: `queued-boot-input-${index}`,
    }));
    const later = { ...marker, id: "later-host-marker" };
    expect(pendingBootContext([marker, ...receipts, human, later])).toEqual([later]);
  });

  it.each([
    { ...receipt, eventType: "claude.platform_message" },
    { ...receipt, eventType: "orb.message" },
    ...["human", "peer", "system", "compaction"].map((inputKind) => ({
      ...receipt,
      overflow: { operationId: marker.id, inputKind },
    })),
    { ...receipt, overflow: { operationId: marker.id } },
    { ...receipt, overflow: { inputKind: "boot" } },
    { ...receipt, overflow: { operationId: "other", inputKind: "boot" } },
  ])("ignores unrelated receipt authority: %j", (unrelated) => {
    expect(pendingBootContext([marker, unrelated])).toEqual([marker]);
  });
});

it.each([
  [0, 0],
  [1, 0],
  [1, 1],
  [1, 2],
])(
  "early passive acknowledgement preserves the human turn (%i turns, %i copies)",
  async (numTurns, copies) => {
    const f = new ComposedClaudeFixture();
    const input = async () => {
      const next = await f.query.input.next();
      if (next.done || !next.value.uuid) throw new Error("Native input missing.");
      return { ...next.value, uuid: next.value.uuid };
    };
    try {
      f.history.appendPlatform(boot("old", "pi-orb.boot"))._unsafeUnwrap();
      f.append({ type: "user", uuid: "human", message: { role: "user", content: "work" } });
      f.append({
        type: "assistant",
        uuid: "done",
        message: { role: "assistant", content: "done", stop_reason: "end_turn" },
      });
      (
        await f.agent.attachSession(f.state, f.history, f.configDir, "commit", null)
      )._unsafeUnwrap();
      expect(f.queries).toHaveLength(1);
      expect(f.agent.getHealth()).toMatchObject({
        status: "ready",
        activity: "idle",
        turnResume: { outcome: "notified_restart" },
      });
      const [marker] = pendingBootContext(f.history.view);
      if (!marker) throw new Error("Passive boot marker missing.");
      expect(marker?.overflow.operationId).toBeUndefined();
      expect(claudeBootEntries([marker])).toMatchObject([
        { type: "custom", customType: "pi-orb.host-restarted" },
      ]);
      (
        await f.agent.submitMessage([{ type: "text", text: "new task" }], "legitimate")
      )._unsafeUnwrap();
      const context = await input(),
        human = await input();
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
      await f.query.emitUnscheduled({
        ...rootResult,
        num_turns: 0,
        user_message_uuids: [context.uuid],
      } as SDKMessage);
      expect(f.agent.gateView()).toMatchObject({
        activity: "busy",
        activeOperationId: "legitimate",
      });
      expect(f.agent.getHealth()).toMatchObject({ status: "ready" });
      expect(f.query.closeRequested).toBe(false);
      expect(pendingBootContext(f.history.view)).toEqual([marker]);
      if (copies === 0) f.receipt(context);
      else {
        for (let index = 0; index < copies; index++)
          f.append({
            type: "attachment",
            uuid: `boot-attachment-${index}`,
            sessionId: f.state.id,
            attachment: {
              type: "queued_command",
              source_uuid: context.uuid,
              delivery_id: "boot-delivery",
              prompt: context.message.content,
              isMeta: true,
            },
          });
        f.append({
          type: "queue-operation",
          operation: "remove",
          reason: "absorbed_mid_turn",
          commandUuid: context.uuid,
          deliveryId: "boot-delivery",
          sessionId: f.state.id,
        });
      }
      f.receipt(human);
      await f.query.emitUnscheduled({
        ...rootResult,
        num_turns: numTurns,
        user_message_uuids: [human.uuid],
      } as SDKMessage);
      f.query.exit();
      f.query.endOutput();
      await f.agent.closeExtensions();
      expect(f.agent.gateView()).toMatchObject({ activity: "idle" });
      const reloaded = new ClaudeHistory(
        join(f.dir, "claude"),
        f.state.id,
        f.state.timestamp,
        f.files,
      );
      const records = reloaded.scan(f.nativePath)._unsafeUnwrap();
      expect(pendingBootContext(records)).toEqual([]);
      const later = { ...marker, id: "later-boot" };
      expect(pendingBootContext([...records, later, boot("automatic")])).toEqual([later]);
      (await f.agent.submitMessage([{ type: "text", text: "another" }], "next"))._unsafeUnwrap();
      expect(await input()).toMatchObject({
        origin: { kind: "human" },
        message: { content: [{ type: "text", text: "another" }] },
      });
    } finally {
      f.query.exit();
      f.query.endOutput();
      f.dispose();
    }
  },
);

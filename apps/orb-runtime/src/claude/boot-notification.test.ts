import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HistoryRecord, OrbBootContext } from "@pi-orb/protocol";
import { describe, expect, it } from "vitest";
import { planBootNotification } from "../pi/boot-notification.ts";
import { claudeBootEntries } from "./boot-notification.ts";
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
      triggerTurn: true,
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

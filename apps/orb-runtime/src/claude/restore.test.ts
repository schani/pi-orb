import type { HistoryRecord } from "@pi-orb/protocol";
import { expect, it } from "vitest";
import { qualifyClaudeRestart } from "./restore.ts";

const receipt: HistoryRecord = {
  type: "message",
  role: "user",
  id: "u",
  parentId: null,
  timestamp: "2026-10-04T00:00:00Z",
  content: [{ type: "text", text: "hello" }],
  overflow: {},
};
const state = { deliveries: { inbox: { uuid: "u", operationId: "op", submitted: true } } };
it("allows manual continuation for a known native input without replaying interrupted inference", () => {
  expect(qualifyClaudeRestart(state, [receipt], "host")._unsafeUnwrap()).toEqual({
    interruptedOperations: ["op"],
    orphanedChildren: [],
  });
  const terminal: HistoryRecord = {
    type: "event",
    eventType: "claude.operation_finished",
    id: "done",
    parentId: "u",
    timestamp: receipt.timestamp,
    overflow: { operationId: "op" },
  };
  expect(
    qualifyClaudeRestart(state, [receipt, terminal], "host")._unsafeUnwrap().interruptedOperations,
  ).toEqual([]);
});
it("fails closed on missing input receipt and child ownership without an execution-lifetime proof", () => {
  expect(qualifyClaudeRestart(state, [], "host").isErr()).toBe(true);
  expect(
    qualifyClaudeRestart(
      { ...state, guardLifetime: "host", ownedChildren: { child: "child" } },
      [receipt],
      "host",
    ).isErr(),
  ).toBe(true);
  expect(
    qualifyClaudeRestart(
      { ...state, guardLifetime: "old-host", ownedChildren: { child: "child" } },
      [receipt],
      "new-host",
    )._unsafeUnwrap().orphanedChildren,
  ).toEqual(["child"]);
});

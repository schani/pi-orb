import type { HistoryRecord, JsonObject } from "@pi-orb/protocol";
import { err, ok } from "neverthrow";
import { expect, it } from "vitest";
import {
  type ClaudeHandoffTerminal,
  qualifyClaudeRestart,
  reconcileClaudeHandoffs,
} from "./restore.ts";

const terminal = (): ClaudeHandoffTerminal => ({
  queryId: "query-a",
  operationId: "operation-a",
  startedId: "start-a",
  notificationId: "terminal-a",
  sessionId: "session-a",
  status: "completed",
  phase: "closing",
  lifetime: "compute-a",
});
function fixture() {
  const state = {
    deliveries: {},
    guardLifetime: "compute-a",
    pendingHandoffs: { task: "Awaiting native result handoff" },
    handoffTerminals: { task: terminal() } as Record<string, ClaudeHandoffTerminal>,
  };
  const records: HistoryRecord[] = [];
  let publications = 0;
  let saved = false;
  const publish = (id: string, overflow: JsonObject) => {
    publications++;
    expect(state.pendingHandoffs.task).toBeDefined();
    records.push({
      id,
      parentId: null,
      timestamp: "2026-10-06T00:00:00Z",
      type: "event",
      eventType: "claude.handoff_interrupted",
      overflow,
    });
    return ok(undefined);
  };
  const save = () => {
    saved = true;
    return ok(undefined);
  };
  return { state, records, publish, save, publications: () => publications, saved: () => saved };
}

it("publishes exact terminal proof before clearing only its handoff", () => {
  const f = fixture();
  const state = {
    ...f.state,
    ownedChildren: { uncertain: "child" },
    ownedTasks: { edge: "task" },
    ownedBackgroundTasks: { inventory: "task" },
  };
  expect(
    reconcileClaudeHandoffs(state, f.records, "compute-a", f.publish, f.save)._unsafeUnwrap(),
  ).toEqual(["task"]);
  expect(f.saved()).toBe(true);
  expect(state.pendingHandoffs).toEqual({});
  expect(state.ownedChildren).toEqual({ uncertain: "child" });
  expect(state.ownedTasks).toEqual({ edge: "task" });
  expect(state.ownedBackgroundTasks).toEqual({ inventory: "task" });
  expect(qualifyClaudeRestart(state, f.records, "compute-a")._unsafeUnwrapErr().code).toBe(
    "claude_child_recovery_required",
  );
  expect(f.records[0]?.overflow).toMatchObject({
    queryId: "query-a",
    operationId: "operation-a",
    taskId: "task",
    startedId: "start-a",
    notificationId: "terminal-a",
    terminalStatus: "completed",
    lifetime: "compute-a",
    phase: "closing",
    disposition: "interrupted",
    automaticReplay: false,
  });
});

it.each([
  "missing-terminal",
  "missing-lifetime",
  "other-lifetime",
  "unknown-query",
  "unknown-operation",
] as const)("retains %s ownership without qualified proof", (kind) => {
  const f = fixture();
  if (kind === "missing-terminal") delete f.state.handoffTerminals.task;
  if (kind === "missing-lifetime") delete (f.state as { guardLifetime?: string }).guardLifetime;
  if (kind === "other-lifetime") f.state.handoffTerminals.task!.lifetime = "old-compute";
  if (kind === "unknown-query") f.state.handoffTerminals.task!.queryId = "";
  if (kind === "unknown-operation") f.state.handoffTerminals.task!.operationId = null;
  expect(
    reconcileClaudeHandoffs(f.state, f.records, "compute-a", f.publish, f.save)._unsafeUnwrap(),
  ).toEqual([]);
  expect(f.state.pendingHandoffs.task).toBeDefined();
  expect(f.publications()).toBe(0);
  expect(qualifyClaudeRestart(f.state, f.records, "compute-a").isErr()).toBe(true);
});

it("retains ownership when disposition publication fails", () => {
  const f = fixture();
  expect(
    reconcileClaudeHandoffs(
      f.state,
      f.records,
      "compute-a",
      () => err({ message: "publication unavailable" }),
      f.save,
    )._unsafeUnwrapErr(),
  ).toMatchObject({ type: "claude_handoff_recovery_error", stage: "publication" });
  expect(f.state.pendingHandoffs.task).toBeDefined();
  expect(f.saved()).toBe(false);
});

it("reconciles a crash after terminal persistence and before disposition", () => {
  const f = fixture();
  const restored = JSON.parse(JSON.stringify(f.state));
  expect(qualifyClaudeRestart(restored, f.records, "compute-a").isErr()).toBe(true);
  expect(reconcileClaudeHandoffs(restored, f.records, "compute-a", f.publish, f.save).isOk()).toBe(
    true,
  );
  expect(qualifyClaudeRestart(restored, f.records, "compute-a").isOk()).toBe(true);
  expect(
    reconcileClaudeHandoffs(restored, f.records, "compute-a", f.publish, f.save)._unsafeUnwrap(),
  ).toEqual([]);
  expect(f.publications()).toBe(1);
});

it("reconciles a crash after disposition publication without duplicating its event", () => {
  const f = fixture();
  const persisted = JSON.parse(JSON.stringify(f.state));
  expect(
    reconcileClaudeHandoffs(f.state, f.records, "compute-a", f.publish, () =>
      err({ message: "save unavailable" }),
    )._unsafeUnwrapErr(),
  ).toMatchObject({ type: "claude_handoff_recovery_error", stage: "persistence" });
  expect(f.state.pendingHandoffs).toEqual(persisted.pendingHandoffs);
  expect(f.state.handoffTerminals).toEqual(persisted.handoffTerminals);
  expect(
    reconcileClaudeHandoffs(persisted, f.records, "compute-a", f.publish, f.save)._unsafeUnwrap(),
  ).toEqual(["task"]);
  expect(f.publications()).toBe(1);
  expect(f.records).toHaveLength(1);
});

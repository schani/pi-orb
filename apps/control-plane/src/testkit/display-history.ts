import type { HistoryRecord } from "@pi-orb/protocol";
import { NoSimulationTask, type SimulationTask } from "determined";
import Fastify from "fastify";
import { expect, onTestFinished } from "vitest";
import { registerRoutes } from "../http/routes.ts";
import { makeHarness, makeOrbRow, makeProjectRow, TEST_SYSTEM_VIEW } from "./fixtures.ts";

export async function seedDisplayHistory(
  task: SimulationTask,
  harness: ReturnType<typeof makeHarness>,
  records: HistoryRecord[],
) {
  const head = records.at(-1);
  if (!head) expect.fail("display history fixture needs records");
  (
    await harness.store.commitPullBatch(task, {
      orbId: "orb",
      expectedCursor: null,
      session: { id: "session", overflow: {} },
      records,
      nextCursor: head.id,
      nextHeadId: head.id,
    })
  )._unsafeUnwrap();
}

export async function openDisplayHistory(records: HistoryRecord[]) {
  const task = new NoSimulationTask("display history", false);
  const harness = makeHarness();
  harness.store.seedProject(makeProjectRow("project"));
  harness.store.seedOrb(makeOrbRow("orb", "project", "stopped"));
  await seedDisplayHistory(task, harness, records);
  const app = Fastify({ logger: false });
  onTestFinished(() => app.close());
  registerRoutes(app, task, harness.deps, {}, TEST_SYSTEM_VIEW);
  return { app, harness, task };
}

export function headlineSource(
  code = "Inspect configuration",
  timestamp = "2026-10-04T00:00:00Z",
): HistoryRecord {
  return {
    id: "record",
    parentId: null,
    overflow: {},
    timestamp,
    type: "message",
    role: "assistant",
    content: [{ type: "tool_call", callId: "call", name: "codemode", arguments: { code } }],
  };
}

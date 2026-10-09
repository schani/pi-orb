import { NoSimulationTask } from "determined";
import { describe, expect, it } from "vitest";
import { makeHarness, makeOrbRow } from "../testkit/fixtures.ts";
import { commitAgentHistory } from "./agent-history.ts";

describe("central derived history", () => {
  it("persists central snapshots without contacting a guest and is idempotent", async () => {
    const harness = makeHarness();
    harness.store.seedOrb(makeOrbRow("central", "project", "running"));
    const snapshot = {
      orbId: "central",
      runtimeInstanceId: "worker",
      activity: "idle" as const,
      session: { id: "durable", overflow: {} },
      records: [],
      headId: null,
    };
    const task = new NoSimulationTask("projection", false);
    expect((await commitAgentHistory(task, harness.deps, snapshot)).isOk()).toBe(true);
    expect((await commitAgentHistory(task, harness.deps, snapshot)).isOk()).toBe(true);
    expect(harness.store.orbSnapshot("central")?.harnessSessionId).toBe("durable");
  });
});

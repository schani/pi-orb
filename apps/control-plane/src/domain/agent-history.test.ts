import { NoSimulationTask } from "determined";
import { okAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { makeHarness, makeOrbRow, seedRunningOrb } from "../testkit/fixtures.ts";
import { commitAgentHistory } from "./agent-history.ts";
import { pollOrbUntilCaughtUp } from "./replication.ts";

describe("central derived history", () => {
  it("initializes the central session from repeated empty snapshots", async () => {
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

for (const consumer of ["poll", "fixed central snapshot"] as const) {
  it(`rechecks concurrent advancement before accepting an empty ${consumer}`, async () => {
    const task = new NoSimulationTask("empty history CAS", false);
    const h = makeHarness();
    seedRunningOrb(task, h, "orb");
    h.world.appendMessage("orb");
    const records = h.world.entriesOf("orb");
    const cursor = records.at(-1)?.id;
    const session = h.world.sessionHeaderOf("orb");
    if (!cursor || !session) throw new Error("missing committed source");
    const stale = { id: session.id, overflow: {} };
    const verify = h.store.initOrVerifySession.bind(h.store);
    vi.spyOn(h.store, "initOrVerifySession").mockImplementationOnce((...args) =>
      h.store
        .commitPullBatch(task, {
          orbId: "orb",
          expectedCursor: null,
          session,
          records,
          nextCursor: cursor,
          nextHeadId: cursor,
        })
        .andThen(() => verify(...args)),
    );
    if (consumer === "poll") {
      vi.spyOn(h.deps.runtimeClient, "pullHistory").mockImplementationOnce(() =>
        okAsync({
          v: 1 as const,
          orbId: "orb",
          runtimeInstanceId: "runtime",
          session: stale,
          activity: "idle" as const,
          records: [],
          cursor: null,
          headId: null,
        }),
      );
      expect(await pollOrbUntilCaughtUp(task, h.deps, "orb")).toMatchObject({ type: "caught_up" });
    } else {
      const result = await commitAgentHistory(task, h.deps, {
        orbId: "orb",
        runtimeInstanceId: "worker",
        activity: "idle",
        session: stale,
        records: [],
        headId: null,
      });
      expect(result._unsafeUnwrapErr()).toMatchObject({
        code: "history_unavailable",
        retryable: true,
        message: "central history cursor is absent from authority",
      });
    }
    expect(h.store.orbSnapshot("orb")).toMatchObject({
      state: "running",
      harnessSessionHeader: session,
      replicationCursor: cursor,
      hostDiscardThroughIncarnation: null,
    });
    expect(h.store.replicaRecords("orb")).toEqual(records);
  });
}

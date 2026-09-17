import { NoSimulationTask } from "determined";
import { describe, expect, it } from "vitest";
import { makeOrbRow, makeProjectRow } from "../testkit/fixtures.ts";
import { InMemoryControlPlaneStore } from "../testkit/store.ts";

const task = new NoSimulationTask("orb sleep store", false);
const caller = { runtimeTokenHash: "hash", hostIncarnation: 2 };

function seeded(state: "running" | "stopped" = "running") {
  const store = new InMemoryControlPlaneStore(0);
  store.seedProject(makeProjectRow("project"));
  store.seedOrb(
    makeOrbRow("orb", "project", state, { runtimeTokenHash: "hash", hostIncarnation: 2 }),
  );
  return store;
}

function required<T>(value: T | null | undefined, label: string): T {
  expect(value, label).toBeDefined();
  expect(value, label).not.toBeNull();
  if (value === undefined || value === null) throw new Error(label);
  return value;
}

describe("scheduled sleep store", () => {
  it("accepts against the current running incarnation and rejects an active sleep", async () => {
    const store = seeded();
    const first = await store.scheduleOrbSleep(task, {
      orbId: "orb",
      caller,
      sleepId: "sleep-1",
      durationSeconds: 10,
    });
    expect(first.isOk()).toBe(true);
    expect(store.orbSnapshot("orb")).toMatchObject({ sleepId: "sleep-1", stateVersion: 1 });
    expect(
      (
        await store.scheduleOrbSleep(task, {
          orbId: "orb",
          caller,
          sleepId: "sleep-2",
          durationSeconds: 20,
        })
      ).isErr(),
    ).toBe(true);
  });

  it("atomically clears a due stopped sleep and creates one wake authority", async () => {
    const store = seeded("stopped");
    const orb = required(store.orbSnapshot("orb"), "seeded orb must exist");
    store.seedOrb({ ...orb, sleepId: "sleep-1", sleepUntil: 20_000 });
    const version = required(store.orbSnapshot("orb"), "sleeping orb must exist").stateVersion;
    const first = await store.processDueOrbSleep(task, {
      orbId: "orb",
      sleepId: "sleep-1",
      expectedStateVersion: version,
      now: 20_000,
    });
    const duplicate = await store.processDueOrbSleep(task, {
      orbId: "orb",
      sleepId: "sleep-1",
      expectedStateVersion: version,
      now: 20_000,
    });
    expect(first.isOk() && first.value).toBe("wake");
    expect(duplicate.isOk() && duplicate.value).toBe("stale");
    expect(store.orbSnapshot("orb")).toMatchObject({ sleepId: null, sleepUntil: null });
    expect(store.messageSnapshots("orb")).toHaveLength(1);
    expect(store.messageSnapshots("orb")[0]).toMatchObject({
      messageId: "sleep-1",
      system: { kind: "sleep_wake" },
      autoStart: true,
      wakeStateVersion: version + 1,
    });
  });

  it("keeps FIFO and singleton provenance for boot context and delivery claims", async () => {
    const store = seeded();
    await store.enqueueOrbMessage(task, {
      orbId: "orb",
      messageId: "human",
      content: [{ type: "text", text: "older" }],
      now: 1,
    });
    store.seedSystemMessage(
      "orb",
      "sleep-1",
      { kind: "sleep_wake", sleepUntil: "1970-01-01T00:00:20.000Z" },
      2,
    );
    expect(
      (await store.readOrbBootContext(task, { orbId: "orb", caller }))._unsafeUnwrap(),
    ).toBeNull();
    const claimed = await store.claimNextOrbMessageBatch(task, { orbId: "orb", now: 3 });
    expect(claimed._unsafeUnwrap().map((row) => row.messageId)).toEqual(["human"]);
  });
});

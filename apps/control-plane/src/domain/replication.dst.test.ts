import { describe, expect, it } from "vitest";
import { FAILPOINTS } from "../testkit/failpoints.ts";
import { makeHarness, seedRunningOrb } from "../testkit/fixtures.ts";
import {
  assertAtMostOneHost,
  assertReplicaComplete,
  assertReplicaIntegrity,
} from "../testkit/invariants.ts";
import { runDst, waitUntil } from "../testkit/sim.ts";
import { pollLoop, reconcileLoop } from "./loops.ts";

const ORB = "orb-a";

describe("history replication (DST)", () => {
  it("acceptance: two concurrent pollers never duplicate or drop a record", async () => {
    await runDst({ name: "concurrent-pollers", iterations: 40 }, async (sim) => {
      const harness = makeHarness();
      const stop = new AbortController();
      const result = await sim.runTasks([
        {
          name: "poller-1",
          f: (task) => pollLoop(task, harness.deps, stop.signal),
        },
        {
          name: "poller-2",
          f: (task) => pollLoop(task, harness.deps, stop.signal),
        },
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            for (let i = 0; i < 12; i++) {
              await task.sleep(1 + task.random("append gap") * 4_000, "append gap");
              harness.world.appendMessage(ORB);
            }
            await waitUntil(
              task,
              "replica complete",
              () => harness.store.replicaRecords(ORB).length === 12,
              { timeoutMs: 300_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(
        result.isOk(),
        `simulation failed: ${result.isErr() ? result.error.message : ""}`,
      ).toBe(true);
      assertReplicaComplete(harness.world, harness.store, ORB);
      assertAtMostOneHost(harness.world, ORB);
    });
  });

  it("retryable pull/commit failures never lose or duplicate records", async () => {
    await runDst(
      {
        name: "retryable-failures",
        iterations: 40,
        failpointProbabilities: {
          [FAILPOINTS.runtimePull]: 0.2,
          [FAILPOINTS.storeCommitBefore]: 0.15,
          [FAILPOINTS.storeCommitAfter]: 0.1,
          [FAILPOINTS.providerObserve]: 0.1,
          [FAILPOINTS.storeRead]: 0.05,
        },
      },
      async (sim) => {
        const harness = makeHarness();
        const stop = new AbortController();
        const result = await sim.runTasks([
          { name: "poller", f: (task) => pollLoop(task, harness.deps, stop.signal) },
          {
            name: "driver",
            f: async (task) => {
              seedRunningOrb(task, harness, ORB);
              for (let i = 0; i < 8; i++) {
                await task.sleep(1 + task.random("append gap") * 3_000, "append gap");
                harness.world.appendMessage(ORB);
              }
              await waitUntil(
                task,
                "replica complete despite failures",
                () => harness.store.replicaRecords(ORB).length === 8,
                { timeoutMs: 600_000 },
              );
              stop.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        assertReplicaComplete(harness.world, harness.store, ORB);
      },
    );
  });

  it("a long runtime outage delays but never corrupts replication", async () => {
    await runDst({ name: "pull-outage", iterations: 25 }, async (sim) => {
      const harness = makeHarness();
      const stop = new AbortController();
      const result = await sim.runTasks([
        { name: "poller", f: (task) => pollLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            harness.world.appendMessage(ORB);
            harness.world.appendMessage(ORB);
            await waitUntil(task, "first records replicated", () => {
              return harness.store.replicaRecords(ORB).length === 2;
            });
            harness.world.setPullOutage(task, ORB, 8_000);
            harness.world.appendMessage(ORB);
            harness.world.appendMessage(ORB);
            await waitUntil(
              task,
              "outage over, replica complete",
              () => harness.store.replicaRecords(ORB).length === 4,
              { timeoutMs: 120_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      assertReplicaComplete(harness.world, harness.store, ORB);
    });
  });

  it("a session-header mismatch fails the orb and stops the host, replica intact", async () => {
    await runDst({ name: "session-mismatch", iterations: 25 }, async (sim) => {
      const harness = makeHarness();
      const stop = new AbortController();
      const result = await sim.runTasks([
        { name: "poller", f: (task) => pollLoop(task, harness.deps, stop.signal) },
        // The reconciler is the backstop that stops the host if the
        // integrity path's own stop attempt was cancelled.
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            harness.world.appendMessage(ORB);
            await waitUntil(
              task,
              "first record replicated",
              () => harness.store.replicaRecords(ORB).length === 1,
            );
            harness.world.corruptSession(ORB);
            harness.world.appendMessage(ORB);
            await waitUntil(
              task,
              "orb failed",
              () => harness.store.orbSnapshot(ORB)?.state === "failed",
              { timeoutMs: 120_000 },
            );
            await waitUntil(
              task,
              "host stopped",
              () => harness.world.hostStateOf(ORB) === "stopped",
              { timeoutMs: 120_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      const orb = harness.store.orbSnapshot(ORB);
      expect(orb?.state).toBe("failed");
      expect(orb?.lastError).toContain("replication_integrity");
      // The replica retains what was committed before the corruption.
      expect(harness.store.replicaRecords(ORB).length).toBe(1);
    });
  });

  it("an unknown cursor (409) fails the orb without resetting the replica", async () => {
    await runDst({ name: "cursor-not-found", iterations: 25 }, async (sim) => {
      const harness = makeHarness();
      const stop = new AbortController();
      const result = await sim.runTasks([
        { name: "poller", f: (task) => pollLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            harness.world.appendMessage(ORB);
            harness.world.appendMessage(ORB);
            await waitUntil(
              task,
              "records replicated",
              () => harness.store.replicaRecords(ORB).length === 2,
            );
            // Wipe persisted entries: the committed cursor now dangles.
            harness.world.truncateEntries(ORB, 0);
            await waitUntil(
              task,
              "orb failed on cursor_not_found",
              () => harness.store.orbSnapshot(ORB)?.state === "failed",
              { timeoutMs: 120_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      // Never silently reset to a full replay: committed records stay.
      expect(harness.store.replicaRecords(ORB).length).toBe(2);
      expect(harness.store.orbSnapshot(ORB)?.lastError).toContain("replication_integrity");
    });
  });

  it("a wrong orbId in the pull response is an integrity failure", async () => {
    await runDst({ name: "orb-mismatch", iterations: 15 }, async (sim) => {
      const harness = makeHarness();
      const stop = new AbortController();
      const result = await sim.runTasks([
        { name: "poller", f: (task) => pollLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            harness.world.reportWrongOrbId(ORB, "orb-other");
            harness.world.appendMessage(ORB);
            await waitUntil(
              task,
              "orb failed on orb mismatch",
              () => harness.store.orbSnapshot(ORB)?.state === "failed",
              { timeoutMs: 120_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.store.replicaRecords(ORB).length).toBe(0);
    });
  });

  it("database snapshot plus live records after its cursor is gap- and duplicate-free", async () => {
    await runDst({ name: "db-live-handoff", iterations: 30 }, async (sim) => {
      const harness = makeHarness();
      const stop = new AbortController();
      const result = await sim.runTasks([
        { name: "poller", f: (task) => pollLoop(task, harness.deps, stop.signal) },
        {
          name: "appender",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            for (let i = 0; i < 10; i++) {
              await task.sleep(1 + task.random("append gap") * 2_000, "append gap");
              harness.world.appendMessage(ORB);
            }
          },
        },
        {
          name: "browser",
          f: async (task) => {
            // Wait until the orb exists and some history flows, then do the
            // §8.3 handoff: DB snapshot at cursor C, then live records after C.
            await waitUntil(task, "some replication", () => {
              return harness.store.replicaRecords(ORB).length >= 1;
            });
            await task.sleep(1 + task.random("handoff delay") * 5_000, "handoff delay");
            const snapshot = harness.store.replicaRecords(ORB);
            const cursor = harness.store.orbSnapshot(ORB)?.replicationCursor ?? null;
            // The runtime replays complete records after C (fake: filesystem).
            await waitUntil(task, "all appended", () => {
              return harness.world.entriesOf(ORB).length === 10;
            });
            const entries = harness.world.entriesOf(ORB);
            const cursorIndex =
              cursor === null ? -1 : entries.findIndex((record) => record.id === cursor);
            expect(cursor === null || cursorIndex !== -1).toBe(true);
            const live = entries.slice(cursorIndex + 1);
            const combined = [...snapshot, ...live];
            // No gaps, no duplicates: combined must equal the full history.
            expect(combined.map((record) => record.id)).toEqual(entries.map((record) => record.id));
            await waitUntil(
              task,
              "replica complete",
              () => harness.store.replicaRecords(ORB).length === 10,
              { timeoutMs: 300_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      assertReplicaComplete(harness.world, harness.store, ORB);
      assertReplicaIntegrity(harness.world, harness.store, ORB);
    });
  });
});

import { errAsync } from "neverthrow";
import { expect, it } from "vitest";
import { FAILPOINTS } from "../testkit/failpoints.ts";
import { makeHarness, seedRunningOrb } from "../testkit/fixtures.ts";
import { LogCapture, runDst } from "../testkit/sim.ts";
import { ackOrbAlert } from "./orb-alerts.ts";
import { pollOrbUntilCaughtUp } from "./replication.ts";

it("acknowledges a live alert before the background poller sees it", async () => {
  await runDst({ name: "alert-live-ack", iterations: 20, lateTimerProbability: 0 }, async (sim) => {
    const harness = makeHarness({
      constants: { runtimeRequestTimeoutMs: 60_000, providerOperationTimeoutMs: 60_000 },
    });
    const result = await sim.runTasks([
      {
        name: "driver",
        f: async (task) => {
          seedRunningOrb(task, harness, "orb");
          const a = harness.world.appendAlert("orb", "first");
          const ack = await ackOrbAlert(task, harness.deps, "orb", a.id);
          expect(ack._unsafeUnwrap().unreadAlertId).toBeNull();
          expect(harness.store.orbSnapshot("orb")?.replicationCursor).toBe(a.id);
          expect(harness.store.orbSnapshot("orb")?.unreadAlertId).toBeNull();
        },
      },
    ]);
    expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
  });
});

it("concurrent ack A and publication B cannot clear B", async () => {
  await runDst(
    { name: "alert-concurrent-ack-publish", iterations: 30, lateTimerProbability: 0 },
    async (sim) => {
      const harness = makeHarness({
        constants: { runtimeRequestTimeoutMs: 60_000, providerOperationTimeoutMs: 60_000 },
      });
      const result = await sim.runTasks([
        {
          name: "setup",
          f: async (task) => {
            seedRunningOrb(task, harness, "orb");
            const a = harness.world.appendAlert("orb", "first");
            expect((await pollOrbUntilCaughtUp(task, harness.deps, "orb")).type).toBe("caught_up");
            expect(harness.store.orbSnapshot("orb")?.unreadAlertId).toBe(a.id);
            harness.world.appendAlert("orb", "second");
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      const concurrent = await sim.runTasks([
        {
          name: "ack A",
          f: async (task) => {
            const ack = await ackOrbAlert(task, harness.deps, "orb", "orb-rec-1");
            expect([null, "orb-rec-2"]).toContain(ack._unsafeUnwrap().unreadAlertId);
          },
        },
        {
          name: "publish B",
          f: async (task) => {
            expect((await pollOrbUntilCaughtUp(task, harness.deps, "orb")).type).toBe("caught_up");
          },
        },
      ]);
      expect(concurrent.isOk(), concurrent.isErr() ? concurrent.error.message : "").toBe(true);
      expect(harness.store.orbSnapshot("orb")?.unreadAlertId).toBe("orb-rec-2");
    },
  );
});

it("a bounded live ack stops after repeated cursor conflicts", async () => {
  await runDst(
    { name: "alert-ack-conflicts", iterations: 5, lateTimerProbability: 0 },
    async (sim) => {
      const harness = makeHarness({
        constants: { runtimeRequestTimeoutMs: 60_000, providerOperationTimeoutMs: 60_000 },
      });
      let commits = 0;
      const deps = {
        ...harness.deps,
        store: new Proxy(harness.store, {
          get(target, property, receiver) {
            if (property === "commitPullBatch")
              return () => {
                commits++;
                return errAsync({ type: "cursor_conflict" as const });
              };
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
      };
      const result = await sim.runTasks([
        {
          name: "ack",
          f: async (task) => {
            seedRunningOrb(task, harness, "orb");
            const a = harness.world.appendAlert("orb", "first");
            expect((await ackOrbAlert(task, deps, "orb", a.id))._unsafeUnwrapErr().type).toBe(
              "unavailable",
            );
            expect(commits).toBeGreaterThan(0);
            expect(commits).toBeLessThanOrEqual(2);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    },
  );
});

it.each(["before", "after"] as const)(
  "ack response loss %s commit remains idempotent",
  async (window) => {
    await runDst(
      {
        name: `alert-ack-${window}`,
        iterations: 5,
        lateTimerProbability: 0,
        failpointProbabilities: {
          [window === "before" ? FAILPOINTS.storeAckBefore : FAILPOINTS.storeAckAfter]: 1,
        },
      },
      async (sim) => {
        const harness = makeHarness({
          constants: { runtimeRequestTimeoutMs: 60_000, providerOperationTimeoutMs: 60_000 },
        });
        const result = await sim.runTasks([
          {
            name: "ack",
            f: async (task) => {
              seedRunningOrb(task, harness, "orb");
              const a = harness.world.appendAlert("orb", "first");
              expect((await pollOrbUntilCaughtUp(task, harness.deps, "orb")).type).toBe(
                "caught_up",
              );
              expect(
                (await ackOrbAlert(task, harness.deps, "orb", a.id))._unsafeUnwrapErr().type,
              ).toBe("unavailable");
              expect(harness.store.orbSnapshot("orb")?.unreadAlertId).toBe(
                window === "before" ? a.id : null,
              );
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      },
    );
  },
);

it("duplicate concurrent pollers publish an alert once", async () => {
  const logs = new LogCapture();
  await runDst(
    { name: "alert-duplicate-pollers", iterations: 30, lateTimerProbability: 0, logCapture: logs },
    async (sim) => {
      const harness = makeHarness({
        constants: { runtimeRequestTimeoutMs: 60_000, providerOperationTimeoutMs: 60_000 },
      });
      const setup = await sim.runTasks([
        {
          name: "setup",
          f: async (task) => {
            seedRunningOrb(task, harness, "orb");
            harness.world.appendAlert("orb", "first");
          },
        },
      ]);
      expect(setup.isOk()).toBe(true);
      const result = await sim.runTasks(
        ["poller 1", "poller 2"].map((name) => ({
          name,
          f: async (task) => {
            expect((await pollOrbUntilCaughtUp(task, harness.deps, "orb")).type).toBe("caught_up");
          },
        })),
      );
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.store.orbSnapshot("orb")?.unreadAlertId).toBe("orb-rec-1");
      expect(harness.store.replicaRecords("orb")).toHaveLength(1);
      expect(logs.lines().filter((line) => line.includes("alert-published"))).toHaveLength(1);
    },
  );
});

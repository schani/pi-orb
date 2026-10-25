import { NoSimulationTask } from "determined";
import { errAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow } from "../testkit/fixtures.ts";
import { LogCapture, runDst } from "../testkit/sim.ts";
import {
  PollDispatcher,
  pollAllOnce,
  pollLoop,
  ReconcileDispatcher,
  reconcileAllOnce,
} from "./loops.ts";

/** A `NoSimulationTask` that keeps the lifecycle lines instead of dropping them. */
class RecordingTask extends NoSimulationTask {
  readonly lines: string[] = [];

  constructor(name: string) {
    super(name, false);
  }

  override log(...parts: readonly unknown[]): void {
    this.lines.push(parts.map((part) => String(part)).join(" "));
  }

  override checkpoint(...parts: readonly unknown[]): Promise<void> {
    this.lines.push(parts.map((part) => String(part)).join(" "));
    return Promise.resolve();
  }
}

/**
 * A `StoreError` with code `invariant` is our own bug — wrong SQL, a parameter
 * the driver cannot encode — so no loop may keep re-attempting it
 * (docs/lifecycle.md, docs/postmortems/2026-08-11-orb-message-jsonb-param-encoding.md).
 * The loops park the subject and log the decision once.
 */
describe("loop handling of a store invariant", () => {
  it("parks the orb's reconciliation instead of retrying with backoff", async () => {
    const task = new RecordingTask("reconcile invariant");
    const harness = makeHarness();
    harness.store.seedProject(makeProjectRow("project-park"));
    harness.store.seedOrb(makeOrbRow("orb-park", "project-park", "stopped"));
    harness.store.failWithInvariant("get orb");

    await reconcileAllOnce(task, harness.deps);
    expect(harness.deps.control.getNextAttemptAt("reconcile:orb-park")).toBe(
      Number.POSITIVE_INFINITY,
    );
    const logged = task.lines.filter((line) => line.includes("reconcile-retry"));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("invariant=true");

    // A parked orb is skipped: the second sweep neither reconciles nor logs again.
    await reconcileAllOnce(task, harness.deps);
    expect(task.lines.filter((line) => line.includes("reconcile-retry"))).toHaveLength(1);
    expect(harness.deps.control.getNextAttemptAt("reconcile:orb-park")).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it("parks the orb's history pulls instead of retrying every tick", async () => {
    const task = new RecordingTask("poll invariant");
    const harness = makeHarness();
    harness.store.seedProject(makeProjectRow("project-poll"));
    harness.store.seedOrb(makeOrbRow("orb-poll", "project-poll", "running"));
    harness.store.failWithInvariant("get orb");

    await pollAllOnce(task, harness.deps);
    expect(harness.deps.control.getNextAttemptAt("poll:orb-poll")).toBe(Number.POSITIVE_INFINITY);
    const logged = task.lines.filter((line) => line.includes("pull-failed"));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("invariant=true");

    await pollAllOnce(task, harness.deps);
    expect(task.lines.filter((line) => line.includes("pull-failed"))).toHaveLength(1);
  });

  it("correlates a nudge arriving during an in-flight pass with the later pass", async () => {
    const task = new RecordingTask("reconcile correlation");
    const harness = makeHarness();
    harness.store.seedProject(makeProjectRow("project-correlation"));
    harness.store.seedOrb(makeOrbRow("orb-correlation", "project-correlation", "stopped"));
    let releaseFirst = (): void => {};
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const dispatcher = new ReconcileDispatcher(
      harness.deps,
      (_orbId, operation) => operation(task),
      async () => {
        calls += 1;
        if (calls === 1) await firstHeld;
        return { type: "noop" };
      },
    );

    await dispatcher.dispatchDue(task);
    const key = "reconcile:orb-correlation";
    harness.deps.control.nudgeNextAttemptAt(key);
    const requestedGeneration = harness.deps.control.getScheduleGeneration(key);
    releaseFirst();
    await dispatcher.drain();

    expect(task.lines).toContain("reconcile.completed orb-correlation 0 noop");
    expect(task.lines).not.toContain(
      `reconcile.completed orb-correlation ${requestedGeneration} noop`,
    );
    await dispatcher.dispatchDue(task);
    await dispatcher.drain();
    expect(task.lines).toContain(`reconcile.completed orb-correlation ${requestedGeneration} noop`);
    expect(calls).toBe(2);
  });

  it("retries an ordinary store outage with bounded backoff and recovers", async () => {
    const capture = new LogCapture();
    await runDst(
      { name: "ordinary-store-outage-retry", iterations: 5, logCapture: capture },
      async (sim) => {
        const harness = makeHarness();
        harness.store.seedProject(makeProjectRow("project-live"));
        harness.store.seedOrb(makeOrbRow("orb-live", "project-live", "stopped"));
        const getOrb = harness.store.getOrb.bind(harness.store);
        let reads = 0;
        harness.store.getOrb = (...args) => {
          reads++;
          return reads <= 2
            ? errAsync({
                type: "store_error",
                code: "unavailable",
                message: "scripted outage",
                retryable: true,
              })
            : getOrb(...args);
        };
        const result = await sim.runTasks([
          {
            name: "outage-driver",
            f: async (task) => {
              const key = "reconcile:orb-live";
              for (let attempt = 1; attempt <= 2; attempt++) {
                const before = task.monotonicNow();
                await reconcileAllOnce(task, harness.deps);
                expect(reads).toBe(attempt);
                const due = harness.deps.control.getNextAttemptAt(key);
                expect(due - before).toBeGreaterThanOrEqual(
                  harness.deps.constants.retryBackoffBaseMs,
                );
                expect(due - task.monotonicNow()).toBeLessThanOrEqual(
                  harness.deps.constants.retryBackoffCapMs,
                );
                expect(Number.isFinite(due)).toBe(true);
                await reconcileAllOnce(task, harness.deps);
                expect(reads).toBe(attempt);
                await task.sleep(due - task.monotonicNow(), "wait for ordinary outage retry");
              }
              await reconcileAllOnce(task, harness.deps);
              expect(reads).toBe(3);
              expect(harness.deps.control.getNextAttemptAt(key) - task.monotonicNow()).toBeCloseTo(
                harness.deps.constants.hostBackstopIntervalMs,
              );
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        expect(capture.matching("reconcile-retry")).toHaveLength(1);
      },
    );
  });

  it("schedules a healthy terminal orb at the host backstop", async () => {
    const task = new RecordingTask("reconcile healthy");
    const harness = makeHarness();
    harness.store.seedProject(makeProjectRow("project-live"));
    harness.store.seedOrb(makeOrbRow("orb-live", "project-live", "stopped"));

    await reconcileAllOnce(task, harness.deps);
    // A healthy terminal orb is a noop parked only until the host backstop.
    const next = harness.deps.control.getNextAttemptAt("reconcile:orb-live");
    expect(Number.isFinite(next)).toBe(true);
    expect(task.lines.filter((line) => line.includes("reconcile-retry"))).toHaveLength(0);
  });
});

describe("poll dispatcher supervision", () => {
  it("drains held work on shutdown without launching a duplicate lane", async () => {
    const task = new RecordingTask("poll drain");
    const h = makeHarness();
    h.store.seedOrb(makeOrbRow("orb", "project", "running", { name: "named" }));
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = (): void => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let calls = 0;
    const stop = new AbortController();
    const loop = pollLoop(task, h.deps, stop.signal, async () => {
      calls++;
      entered();
      await held;
    });
    await started;
    stop.abort();
    let finished = false;
    void loop.then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    release();
    await loop;
    expect(calls).toBe(1);
    expect(finished).toBe(true);
  });

  it("keeps one in-flight lane across repeated sweeps", async () => {
    const task = new RecordingTask("poll duplicate");
    const h = makeHarness();
    h.store.seedOrb(makeOrbRow("orb", "project", "running", { name: "named" }));
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const dispatcher = new PollDispatcher(h.deps, async (key) => {
      calls.push(key);
      await held;
    });
    await pollAllOnce(task, h.deps, dispatcher);
    await pollAllOnce(task, h.deps, dispatcher);
    expect(calls).toEqual(["poll:orb"]);
    release();
    await dispatcher.drain();
  });

  it("rethrows worker crashes and logs only their lane and classification", async () => {
    const task = new RecordingTask("poll crash");
    const h = makeHarness();
    h.store.seedOrb(makeOrbRow("orb", "project", "running", { name: "named" }));
    const failure = new Error("private transcript bytes");
    const dispatcher = new PollDispatcher(h.deps, () => Promise.reject(failure));
    await pollAllOnce(task, h.deps, dispatcher);
    await expect(dispatcher.drain()).rejects.toBe(failure);
    await expect(pollAllOnce(task, h.deps, dispatcher)).rejects.toBe(failure);
    const lines = task.lines.filter((line) => line.includes("poll-task-crashed"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("lane=history");
    expect(lines[0]).toContain("error=unexpected");
    expect(lines[0]).not.toContain(failure.message);
  });
});

import { NoSimulationTask } from "determined";
import { describe, expect, it } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow } from "../testkit/fixtures.ts";
import { pollAllOnce, reconcileAllOnce } from "./loops.ts";

/** A `NoSimulationTask` that keeps the lifecycle lines instead of dropping them. */
class RecordingTask extends NoSimulationTask {
  readonly lines: string[] = [];

  constructor(name: string) {
    super(name, false);
  }

  override log(...parts: readonly unknown[]): void {
    this.lines.push(parts.map((part) => String(part)).join(" "));
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
    harness.store.failWithInvariant("getOrb");

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
    harness.store.failWithInvariant("getOrb");

    await pollAllOnce(task, harness.deps);
    expect(harness.deps.control.getNextAttemptAt("poll:orb-poll")).toBe(Number.POSITIVE_INFINITY);
    const logged = task.lines.filter((line) => line.includes("pull-failed"));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("invariant=true");

    await pollAllOnce(task, harness.deps);
    expect(task.lines.filter((line) => line.includes("pull-failed"))).toHaveLength(1);
  });

  it("keeps ordinary store outages on their normal retry cadence", async () => {
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

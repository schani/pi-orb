import type { OrbState } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { sleepResult, withDeadline } from "./dst.ts";
import { type ReconcileOutcome, reconcileOrbOnce } from "./lifecycle.ts";
import { logEvent, logOrbEvent, logProjectEvent } from "./log.ts";
import type { OrbRow } from "./orb.ts";
import type { ControlPlaneDeps } from "./ports.ts";
import { reconcileProjectDeletionOnce } from "./project-deletion.ts";
import { pollOrbUntilCaughtUp } from "./replication.ts";

/**
 * Starts one reconciliation on a task that is independent from the scheduler
 * task. Production creates a fresh real-time task per orb; deterministic tests
 * supply statically declared SimulationTask workers because `determined`
 * intentionally models one sequential coroutine per task.
 */
export type ReconcileTaskRunner = (
  orbId: string,
  operation: (task: SimulationTask) => Promise<void>,
) => Promise<void>;

export type ReconcileOne = (
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orbId: string,
) => Promise<ReconcileOutcome>;

/**
 * A failure that no retry can clear (a `StoreError` with code `invariant`:
 * wrong SQL, wrong parameter encoding) parks its subject instead of being
 * re-attempted until someone deploys a fix. The park lives in this process's
 * scheduling state, so a restart with corrected code resumes normally; the
 * decision itself is on the durable `lifecycle:` log as an edge, once
 * (docs/lifecycle.md, docs/postmortems/2026-08-11-orb-message-jsonb-param-encoding.md).
 */
const PARKED_FOREVER = Number.POSITIVE_INFINITY;

const POLLABLE_STATES: readonly OrbState[] = ["running"];
const RECONCILABLE_STATES: readonly OrbState[] = [
  "creating",
  "starting",
  "running",
  "stopping",
  "stopped",
  "failed",
  "deleting",
  "archiving",
  "archived",
];

const isTerminal = (state: OrbState): boolean =>
  state === "stopped" || state === "failed" || state === "archived";

/** One sweep: pull every due running orb until caught up. */
export async function pollAllOnce(task: SimulationTask, deps: ControlPlaneDeps): Promise<void> {
  const orbsResult = await deps.store.listOrbsInStates(task, POLLABLE_STATES);
  if (orbsResult.isErr()) {
    // Store outage: retry on the next tick. Logged on the edge only — the tick
    // is ~10s and an outage lasts minutes.
    if (deps.control.noteCondition("poll-loop:list", true)) {
      logEvent(task, "poll-loop-blind", { error: orbsResult.error.message });
    }
    return;
  }
  if (deps.control.noteCondition("poll-loop:list", false)) {
    logEvent(task, "poll-loop-recovered");
  }
  const now = task.monotonicNow();
  for (const orb of orbsResult.value) {
    const key = `poll:${orb.id}`;
    if (deps.control.getNextAttemptAt(key) > now) continue;
    const outcome = await pollOrbUntilCaughtUp(task, deps, orb.id);
    // A runtime going quiet is the first symptom of the failures this loop
    // exists to survive, so the first failing pull of an episode is logged;
    // repeats are not, and a success closes the episode silently.
    if (outcome.type === "retryable") {
      if (deps.control.bumpRetryAttempts(key) === 1) {
        logOrbEvent(task, orb.id, "pull-failed", {
          message: outcome.message,
          ...(outcome.invariant === true ? { invariant: true } : {}),
        });
      }
    } else {
      deps.control.clearRetryAttempts(key);
    }
    // Retryable failures retry at the ordinary polling cadence (docs/history-replication.md); an
    // integrity failure removed the orb from the pollable set, and an invariant
    // failure parks this orb's pulls until the fix is deployed.
    deps.control.setNextAttemptAt(
      key,
      outcome.type === "retryable" && outcome.invariant === true
        ? PARKED_FOREVER
        : task.monotonicNow() + deps.constants.historyPullIntervalMs,
    );
  }
}

export async function pollLoop(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  stop: AbortSignal,
): Promise<void> {
  while (!stop.aborted) {
    await pollAllOnce(task, deps);
    const slept = await sleepResult(task, deps.constants.reconcileTickMs, "poll loop tick", stop);
    if (slept.isErr()) return;
  }
}

function reconcileDelayMs(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orbId: string,
  state: OrbState,
  outcome: ReconcileOutcome,
  retryKey: string,
): number {
  const constants = deps.constants;
  switch (outcome.type) {
    case "retryable": {
      const attempts = deps.control.bumpRetryAttempts(retryKey);
      // Edge only: backoff retries this every few seconds until it clears.
      if (attempts === 1) {
        logOrbEvent(task, orbId, "reconcile-retry", {
          state,
          message: outcome.message,
          ...(outcome.invariant === true ? { invariant: true } : {}),
        });
      }
      if (outcome.invariant === true) return PARKED_FOREVER;
      return Math.min(
        constants.retryBackoffCapMs,
        constants.retryBackoffBaseMs * 2 ** (attempts - 1),
      );
    }
    case "waiting":
      deps.control.clearRetryAttempts(retryKey);
      switch (outcome.reason) {
        case "auth":
        case "readiness":
        case "host_transition":
          return constants.readinessPollMs;
        case "drain_blocked":
        case "deletion_quarantine":
          return constants.reconcileTickMs;
      }
      break;
    case "noop":
      deps.control.clearRetryAttempts(retryKey);
      return isTerminal(state) ? constants.hostBackstopIntervalMs : constants.reconcileTickMs;
    case "progressed":
    case "transitioned":
    case "conflict":
      deps.control.clearRetryAttempts(retryKey);
      return 0;
  }
}

async function reconcileAndScheduleNext(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orb: OrbRow,
  retryKey: string,
  reconcile: ReconcileOne = reconcileOrbOnce,
): Promise<void> {
  const outcome = await reconcile(task, deps, orb.id);
  const delay = reconcileDelayMs(task, deps, orb.id, orb.state, outcome, retryKey);
  deps.control.setNextAttemptAt(retryKey, task.monotonicNow() + delay);
}

/** One sequential sweep, retained as the small deterministic lifecycle-test seam. */
export async function reconcileAllOnce(
  task: SimulationTask,
  deps: ControlPlaneDeps,
): Promise<void> {
  const orbsResult = await deps.store.listOrbsInStates(task, RECONCILABLE_STATES);
  if (orbsResult.isErr()) {
    if (deps.control.noteCondition("reconcile-loop:list", true)) {
      logEvent(task, "reconcile-loop-blind", { error: orbsResult.error.message });
    }
    return;
  }
  if (deps.control.noteCondition("reconcile-loop:list", false)) {
    logEvent(task, "reconcile-loop-recovered");
  }
  const now = task.monotonicNow();
  for (const orb of orbsResult.value) {
    const key = `reconcile:${orb.id}`;
    if (deps.control.getNextAttemptAt(key) > now) continue;
    await reconcileAndScheduleNext(task, deps, orb, key);
  }
}

const unexpectedMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const hasStopped = (stop?: AbortSignal): boolean => stop?.aborted === true;

/**
 * Process-local dispatcher: scans remain sequential on the scheduler task,
 * while every orb operation runs on its own task. The map is both the local
 * at-most-one fence and the shutdown drain. Cross-process overlap remains
 * fenced by the existing store CAS and idempotent provider operations.
 */
export class ReconcileDispatcher {
  private readonly inFlight = new Map<string, Promise<void>>();
  private fatalError: Error | null = null;
  private readonly deps: ControlPlaneDeps;
  private readonly runTask: ReconcileTaskRunner;
  private readonly reconcile: ReconcileOne;

  constructor(
    deps: ControlPlaneDeps,
    runTask: ReconcileTaskRunner,
    reconcile: ReconcileOne = reconcileOrbOnce,
  ) {
    this.deps = deps;
    this.runTask = runTask;
    this.reconcile = reconcile;
  }

  async dispatchDue(task: SimulationTask, stop?: AbortSignal): Promise<void> {
    this.throwIfFatal();
    if (hasStopped(stop)) return;
    const orbsResult = await this.deps.store.listOrbsInStates(task, RECONCILABLE_STATES);
    this.throwIfFatal();
    if (hasStopped(stop)) return;
    if (orbsResult.isErr()) {
      if (this.deps.control.noteCondition("reconcile-loop:list", true)) {
        logEvent(task, "reconcile-loop-blind", { error: orbsResult.error.message });
      }
      return;
    }
    if (this.deps.control.noteCondition("reconcile-loop:list", false)) {
      logEvent(task, "reconcile-loop-recovered");
    }

    const now = task.monotonicNow();
    for (const orb of orbsResult.value) {
      const key = `reconcile:${orb.id}`;
      if (this.deps.control.getNextAttemptAt(key) > now || this.inFlight.has(orb.id)) continue;
      this.dispatch(task, orb, key);
    }
  }

  async drain(): Promise<void> {
    await Promise.all(this.inFlight.values());
    this.throwIfFatal();
  }

  private dispatch(schedulerTask: SimulationTask, orb: OrbRow, retryKey: string): void {
    const operation = this.runTask(orb.id, async (orbTask) => {
      await reconcileAndScheduleNext(orbTask, this.deps, orb, retryKey, this.reconcile);
      this.deps.control.noteCondition(`reconcile-task-crashed:${orb.id}`, false);
    }).catch((error: unknown) => this.captureFatal(schedulerTask, orb.id, error));
    this.inFlight.set(orb.id, operation);
    void operation.then(() => {
      if (this.inFlight.get(orb.id) === operation) this.inFlight.delete(orb.id);
    });
  }

  private captureFatal(task: SimulationTask, orbId: string, error: unknown): void {
    const fatal = error instanceof Error ? error : new Error(unexpectedMessage(error));
    this.fatalError ??= fatal;
    if (this.deps.control.noteCondition(`reconcile-task-crashed:${orbId}`, true)) {
      logOrbEvent(task, orbId, "reconcile-task-crashed", { error: fatal.message });
    }
  }

  private throwIfFatal(): void {
    // biome-ignore lint: This is the narrow background-loop supervisor boundary; unexpected worker failures must reject the loop promise.
    if (this.fatalError !== null) throw this.fatalError;
  }
}

/**
 * Reconcile every due orb without allowing one orb's parked provider/runtime
 * operation to stop discovery of unrelated work. When `runTask` is omitted,
 * use the sequential loop required by the existing single-task DST scenarios;
 * production always supplies an independent-task runner, and the concurrency
 * DST supplies one statically declared worker task per orb.
 */
export async function reconcileLoop(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  stop: AbortSignal,
  runTask?: ReconcileTaskRunner,
  reconcile: ReconcileOne = reconcileOrbOnce,
): Promise<void> {
  if (runTask === undefined) {
    while (!stop.aborted) {
      await reconcileAllOnce(task, deps);
      const slept = await sleepResult(
        task,
        deps.constants.reconcileTickMs,
        "reconcile loop tick",
        stop,
      );
      if (slept.isErr()) return;
    }
    return;
  }

  const dispatcher = new ReconcileDispatcher(deps, runTask, reconcile);
  try {
    while (!stop.aborted) {
      await dispatcher.dispatchDue(task, stop);
      const slept = await sleepResult(
        task,
        deps.constants.reconcileTickMs,
        "reconcile loop tick",
        stop,
      );
      if (slept.isErr()) break;
    }
  } finally {
    await dispatcher.drain();
  }
}

/**
 * One orphan-host sweep (docs/lifecycle.md): stop any managed host whose orb row
 * is missing entirely, or terminal with a lost `host_ref`. The provider lists
 * only pi-orb-labeled hosts, so nothing else in the project is ever touched;
 * the sweep only moves hosts toward "stopped" and never starts or deletes.
 */
/** One sweep over durable project deletion intents. */
export async function projectDeletionAllOnce(
  task: SimulationTask,
  deps: ControlPlaneDeps,
): Promise<void> {
  const projects = await deps.store.listProjectsInState(task, "deleting");
  if (projects.isErr()) {
    if (deps.control.noteCondition("project-deletion-loop:list", true)) {
      logEvent(task, "project-deletion-loop-blind", { error: projects.error.message });
    }
    return;
  }
  if (deps.control.noteCondition("project-deletion-loop:list", false)) {
    logEvent(task, "project-deletion-loop-recovered");
  }
  const now = task.monotonicNow();
  for (const project of projects.value) {
    const key = `project-deletion:${project.id}`;
    // Only an invariant failure ever parks a project, so the ordinary sweep is
    // unchanged: every deleting project is visited on every tick.
    if (deps.control.getNextAttemptAt(key) > now) continue;
    const outcome = await reconcileProjectDeletionOnce(task, deps, project.id);
    const condition = `project-deletion-retry:${project.id}`;
    if (outcome.type === "retryable") {
      if (deps.control.noteCondition(condition, true)) {
        logProjectEvent(task, project.id, "deletion-retry", {
          message: outcome.message,
          ...(outcome.invariant === true ? { invariant: true } : {}),
        });
      }
      if (outcome.invariant === true) deps.control.setNextAttemptAt(key, PARKED_FOREVER);
    } else if (deps.control.noteCondition(condition, false)) {
      logProjectEvent(task, project.id, "deletion-retry-recovered");
    }
  }
}

export async function projectDeletionLoop(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  stop: AbortSignal,
): Promise<void> {
  while (!stop.aborted) {
    await projectDeletionAllOnce(task, deps);
    const slept = await sleepResult(
      task,
      deps.constants.reconcileTickMs,
      "project deletion tick",
      stop,
    );
    if (slept.isErr()) return;
  }
}

export async function orphanSweepOnce(task: SimulationTask, deps: ControlPlaneDeps): Promise<void> {
  const listed = await withDeadline(
    task,
    deps.constants.providerOperationTimeoutMs,
    "list managed hosts",
    (context) => deps.hostProvider.listManagedHosts(task, context),
  );
  if (listed.isErr()) {
    // Retry at the next sweep interval; logged on the edge only.
    if (deps.control.noteCondition("orphan-sweep:list", true)) {
      logEvent(task, "orphan-sweep-blind", { error: listed.error.message });
    }
    return;
  }
  if (deps.control.noteCondition("orphan-sweep:list", false)) {
    logEvent(task, "orphan-sweep-recovered");
  }
  for (const observation of listed.value) {
    if (observation.state === "stopping") continue;
    const orbResult = await deps.store.getOrb(task, observation.orbId);
    if (orbResult.isErr()) continue; // Store outage: the next sweep retries.
    const orb = orbResult.value;
    const host = `${observation.ref.provider}/${observation.ref.resourceId}`;
    if (orb?.state === "archived") {
      logOrbEvent(task, orb.id, "archived-host-resurrected", { host, decision: "destroy" });
      const destroyed = await withDeadline(
        task,
        deps.constants.providerOperationTimeoutMs,
        "destroy resurrected archived host",
        (context) => deps.hostProvider.destroy(task, orb.id, context),
      );
      if (destroyed.isErr()) {
        logOrbEvent(task, orb.id, "archived-host-destroy-failed", {
          host,
          error: destroyed.error.message,
        });
      }
      continue;
    }
    if (observation.state === "stopped") continue;
    // An orphan is an integrity signal (docs/lifecycle.md): logged loudly, and
    // logged again on every sweep for as long as the host survives the stop.
    if (orb === null) {
      logOrbEvent(task, observation.orbId, "orphan-host", {
        host,
        reason: "no_orb_row",
        detail: "lost provision commit or database reset",
        decision: "stop",
      });
    } else if (
      (orb.state === "stopped" || orb.state === "failed") &&
      orb.hostRef !== observation.ref.resourceId
    ) {
      logOrbEvent(task, orb.id, "orphan-host", {
        host,
        reason: "stale_host_ref",
        orb_state: orb.state,
        recorded_host_ref: orb.hostRef,
        decision: "stop",
      });
    } else {
      // Live orbs and matching-ref terminal orbs are the reconciler's job
      // (docs/lifecycle.md backstop); the sweep never competes with it.
      continue;
    }
    // Best effort; a failure here is retried on the next sweep.
    const stopped = await withDeadline(
      task,
      deps.constants.providerOperationTimeoutMs,
      "stop orphan host",
      (context) => deps.hostProvider.stop(task, observation.ref, context),
    );
    if (stopped.isErr()) {
      logOrbEvent(task, observation.orbId, "orphan-host-stop-failed", {
        host,
        error: stopped.error.message,
      });
    }
  }
}

export async function orphanSweepLoop(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  stop: AbortSignal,
): Promise<void> {
  while (!stop.aborted) {
    await orphanSweepOnce(task, deps);
    const slept = await sleepResult(
      task,
      deps.constants.orphanSweepIntervalMs,
      "orphan sweep tick",
      stop,
    );
    if (slept.isErr()) return;
  }
}

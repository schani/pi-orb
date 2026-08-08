import type { OrbState } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { sleepResult, withDeadline } from "./dst.ts";
import { type ReconcileOutcome, reconcileOrbOnce } from "./lifecycle.ts";
import { logEvent, logOrbEvent } from "./log.ts";
import type { ControlPlaneDeps } from "./ports.ts";
import { pollOrbUntilCaughtUp } from "./replication.ts";

const POLLABLE_STATES: readonly OrbState[] = ["running"];
const RECONCILABLE_STATES: readonly OrbState[] = [
  "creating",
  "starting",
  "running",
  "stopping",
  "stopped",
  "failed",
  "deleting",
];

const isTerminal = (state: OrbState): boolean => state === "stopped" || state === "failed";

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
        logOrbEvent(task, orb.id, "pull-failed", { message: outcome.message });
      }
    } else {
      deps.control.clearRetryAttempts(key);
    }
    // Retryable failures retry at the ordinary polling cadence (docs/history-replication.md); an
    // integrity failure removed the orb from the pollable set.
    deps.control.setNextAttemptAt(key, task.monotonicNow() + deps.constants.historyPullIntervalMs);
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
        logOrbEvent(task, orbId, "reconcile-retry", { state, message: outcome.message });
      }
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

/** One sweep: reconcile every due orb. */
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
    const outcome = await reconcileOrbOnce(task, deps, orb.id);
    const delay = reconcileDelayMs(task, deps, orb.id, orb.state, outcome, key);
    deps.control.setNextAttemptAt(key, task.monotonicNow() + delay);
  }
}

export async function reconcileLoop(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  stop: AbortSignal,
): Promise<void> {
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
}

/**
 * One orphan-host sweep (docs/lifecycle.md): stop any managed host whose orb row
 * is missing entirely, or terminal with a lost `host_ref`. The provider lists
 * only pi-orb-labeled hosts, so nothing else in the project is ever touched;
 * the sweep only moves hosts toward "stopped" and never starts or deletes.
 */
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
    if (observation.state === "stopped" || observation.state === "stopping") continue;
    const orbResult = await deps.store.getOrb(task, observation.orbId);
    if (orbResult.isErr()) continue; // Store outage: the next sweep retries.
    const orb = orbResult.value;
    const host = `${observation.ref.provider}/${observation.ref.resourceId}`;
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

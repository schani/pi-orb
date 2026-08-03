import type { OrbState } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { sleepResult, withDeadline } from "./dst.ts";
import { type ReconcileOutcome, reconcileOrbOnce } from "./lifecycle.ts";
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
];

const isTerminal = (state: OrbState): boolean => state === "stopped" || state === "failed";

/** One sweep: pull every due running orb until caught up. */
export async function pollAllOnce(task: SimulationTask, deps: ControlPlaneDeps): Promise<void> {
  const orbsResult = await deps.store.listOrbsInStates(task, POLLABLE_STATES);
  if (orbsResult.isErr()) return; // Store outage: retry on the next tick.
  const now = task.monotonicNow();
  for (const orb of orbsResult.value) {
    const key = `poll:${orb.id}`;
    if (deps.control.getNextAttemptAt(key) > now) continue;
    await pollOrbUntilCaughtUp(task, deps, orb.id);
    // Retryable failures retry at the ordinary polling cadence (§8.2); an
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
  deps: ControlPlaneDeps,
  state: OrbState,
  outcome: ReconcileOutcome,
  retryKey: string,
): number {
  const constants = deps.constants;
  switch (outcome.type) {
    case "retryable": {
      const attempts = deps.control.bumpRetryAttempts(retryKey);
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
  if (orbsResult.isErr()) return;
  const now = task.monotonicNow();
  for (const orb of orbsResult.value) {
    const key = `reconcile:${orb.id}`;
    if (deps.control.getNextAttemptAt(key) > now) continue;
    const outcome = await reconcileOrbOnce(task, deps, orb.id);
    const delay = reconcileDelayMs(deps, orb.state, outcome, key);
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
 * One orphan-host sweep (DESIGN.md §3.4): stop any managed host whose orb row
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
  if (listed.isErr()) return; // Retry at the next sweep interval.
  for (const observation of listed.value) {
    if (observation.state === "stopped" || observation.state === "stopping") continue;
    const orbResult = await deps.store.getOrb(task, observation.orbId);
    if (orbResult.isErr()) continue; // Store outage: the next sweep retries.
    const orb = orbResult.value;
    const host = `${observation.ref.provider}/${observation.ref.resourceId}`;
    if (orb === null) {
      task.log(
        `orphan-host sweep: host ${host} is labeled for orb ${observation.orbId}, which has ` +
          "no orb row (lost provision commit or database reset); stopping it",
      );
    } else if (
      (orb.state === "stopped" || orb.state === "failed") &&
      orb.hostRef !== observation.ref.resourceId
    ) {
      task.log(
        `orphan-host sweep: host ${host} belongs to ${orb.state} orb ${orb.id} but is not its ` +
          "recorded host_ref; stopping it",
      );
    } else {
      // Live orbs and matching-ref terminal orbs are the reconciler's job
      // (§5.2 backstop); the sweep never competes with it.
      continue;
    }
    // Best effort; a failure here is retried on the next sweep.
    await withDeadline(
      task,
      deps.constants.providerOperationTimeoutMs,
      "stop orphan host",
      (context) => deps.hostProvider.stop(task, observation.ref, context),
    );
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

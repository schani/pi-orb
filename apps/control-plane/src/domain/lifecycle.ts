import type { OrbState, StopReason } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import { withDeadline } from "./dst.ts";
import {
  formatOrbFailure,
  type OrbFailureCode,
  type OrbHostProviderError,
  type StateConflict,
  type StoreError,
} from "./errors.ts";
import { hasNeverBeenReady, type OrbRow } from "./orb.ts";
import type { ControlPlaneDeps, OrbHostObservation, OrbHostRef } from "./ports.ts";
import { pollOrbUntilCaughtUp } from "./replication.ts";

export type ReconcileOutcome =
  | { readonly type: "noop" }
  | {
      readonly type: "waiting";
      readonly reason: "auth" | "readiness" | "host_transition" | "drain_blocked";
    }
  | { readonly type: "progressed" }
  | { readonly type: "transitioned"; readonly toState: OrbState }
  | { readonly type: "retryable"; readonly message: string }
  | { readonly type: "conflict" };

const retryable = (message: string): ReconcileOutcome => ({ type: "retryable", message });
const waiting = (reason: "auth" | "readiness" | "host_transition" | "drain_blocked") =>
  ({ type: "waiting", reason }) as const;

async function diagnoseHost(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  resourceId: string,
): Promise<{ settled: boolean; evidence: string | null }> {
  const diagnose = deps.hostProvider.diagnose?.bind(deps.hostProvider);
  if (diagnose === undefined) return { settled: true, evidence: null };
  const result = await withDeadline(
    task,
    deps.constants.providerOperationTimeoutMs,
    "diagnose host",
    (context) => diagnose(task, hostRefOf(deps, resourceId), context),
  );
  // A transient diagnose failure defers the caller's decision one poll so
  // host evidence is never silently dropped.
  if (result.isErr()) return { settled: false, evidence: null };
  return { settled: true, evidence: result.value };
}

/** Fold the boot probe's live picture into a terminal error message. */
function deadlineEvidence(deps: ControlPlaneDeps, orbId: string, base: string): string {
  const probe = deps.control.getBootProbe(orbId);
  if (probe === null) return base;
  const parts = [base];
  if (probe.hostState !== null) parts.push(`host ${probe.hostState}`);
  parts.push(`${probe.attempts} probes`);
  parts.push(probe.everAnswered ? "runtime answered at least once" : "runtime never answered");
  if (probe.lastError !== undefined) parts.push(`last probe error: ${probe.lastError}`);
  return parts.join("; ");
}

function hostRefOf(deps: ControlPlaneDeps, resourceId: string): OrbHostRef {
  return { provider: deps.hostProvider.kind, resourceId };
}

async function observeHost(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  resourceId: string,
): Promise<Result<OrbHostObservation | null, OrbHostProviderError>> {
  return withDeadline(task, deps.constants.providerOperationTimeoutMs, "observe host", (context) =>
    deps.hostProvider.observe(task, hostRefOf(deps, resourceId), context),
  );
}

async function stopHost(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  resourceId: string,
): Promise<Result<void, OrbHostProviderError>> {
  return withDeadline(task, deps.constants.providerOperationTimeoutMs, "stop host", (context) =>
    deps.hostProvider.stop(task, hostRefOf(deps, resourceId), context),
  );
}

async function startHost(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  resourceId: string,
): Promise<Result<void, OrbHostProviderError>> {
  return withDeadline(task, deps.constants.providerOperationTimeoutMs, "start host", (context) =>
    deps.hostProvider.start(task, hostRefOf(deps, resourceId), context),
  );
}

/** CAS the orb to `failed` with a typed error. */
async function failOrb(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orb: OrbRow,
  code: OrbFailureCode,
  message: string,
): Promise<ReconcileOutcome> {
  const cas = await deps.store.casTransition(task, {
    orbId: orb.id,
    expectedStateVersion: orb.stateVersion,
    toState: "failed",
    now: task.wallNow(),
    lastError: formatOrbFailure(code, message),
  });
  if (cas.isErr()) {
    return cas.error.type === "state_conflict"
      ? { type: "conflict" }
      : retryable(cas.error.message);
  }
  deps.control.clearOrb(orb.id);
  return { type: "transitioned", toState: "failed" };
}

/** Stop the host (best effort, tolerating absence and errors), then fail the orb. */
async function failOrbStoppingHost(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orb: OrbRow,
  code: OrbFailureCode,
  message: string,
): Promise<ReconcileOutcome> {
  if (orb.hostRef !== null) {
    await stopHost(task, deps, orb.hostRef);
  }
  return failOrb(task, deps, orb, code, message);
}

async function transitionTo(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orb: OrbRow,
  toState: OrbState,
  extra?: { lastError?: string | null; stopReason?: StopReason | null },
): Promise<ReconcileOutcome> {
  const cas = await deps.store.casTransition(task, {
    orbId: orb.id,
    expectedStateVersion: orb.stateVersion,
    toState,
    now: task.wallNow(),
    ...(extra?.lastError !== undefined ? { lastError: extra.lastError } : {}),
    ...(extra?.stopReason !== undefined ? { stopReason: extra.stopReason } : {}),
  });
  if (cas.isErr()) {
    return cas.error.type === "state_conflict"
      ? { type: "conflict" }
      : retryable(cas.error.message);
  }
  if (toState === "stopped" || toState === "failed") deps.control.clearOrb(orb.id);
  return { type: "transitioned", toState };
}

// ---------------------------------------------------------------------------
// creating / starting

async function reconcileCreateStart(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  initial: OrbRow,
): Promise<ReconcileOutcome> {
  let orb = initial;

  // 1. Codex auth is a prerequisite for host work (DESIGN.md §15.1).
  const auth = await deps.authGate.ensureAuth(task);
  if (auth.isErr()) return retryable(auth.error.message);
  const resolution = auth.value;
  if (resolution.status === "pending") {
    deps.control.markAuthBlocked(orb.id);
    deps.control.setChallenge(resolution.challenge);
    return waiting("auth");
  }
  if (resolution.status === "failed") {
    // Every orb waiting on this flow moves to failed with a typed error.
    deps.control.setChallenge(null);
    const cohort = new Set([...deps.control.getAuthBlockedOrbs(), orb.id]);
    let outcome: ReconcileOutcome = { type: "conflict" };
    for (const blockedId of cohort) {
      const blockedResult = await deps.store.getOrb(task, blockedId);
      if (blockedResult.isErr()) continue;
      const blocked = blockedResult.value;
      if (blocked === null || (blocked.state !== "creating" && blocked.state !== "starting")) {
        deps.control.clearAuthBlocked(blockedId);
        continue;
      }
      const failed = await failOrb(task, deps, blocked, "auth_failed", resolution.message);
      if (blockedId === orb.id) outcome = failed;
    }
    return outcome;
  }
  deps.control.setChallenge(null);
  if (deps.control.isAuthBlocked(orb.id)) {
    // OAuth completed: re-enter with a fresh state_changed_at so login time
    // never consumes the create/start deadline (DESIGN.md §5.2).
    const reentered = await deps.store.casReenterState(task, {
      orbId: orb.id,
      expectedStateVersion: orb.stateVersion,
      now: task.wallNow(),
    });
    if (reentered.isErr()) {
      return reentered.error.type === "state_conflict"
        ? { type: "conflict" }
        : retryable(reentered.error.message);
    }
    deps.control.clearAuthBlocked(orb.id);
    orb = reentered.value;
  }

  // 2. Create/start deadline (DESIGN.md §5.2 deadline_exceeded rule).
  if (task.wallNow() - orb.stateChangedAt > deps.constants.createStartDeadlineMs) {
    return failOrbStoppingHost(
      task,
      deps,
      orb,
      "deadline_exceeded",
      deadlineEvidence(
        deps,
        orb.id,
        `orb did not become ready within ${deps.constants.createStartDeadlineMs}ms`,
      ),
    );
  }

  // 3. Ensure a host exists.
  let hostResourceId = orb.hostRef;
  if (hostResourceId === null) {
    const projectResult = await deps.store.getProject(task, orb.projectId);
    if (projectResult.isErr()) return retryable(projectResult.error.message);
    const project = projectResult.value;
    if (project === null) {
      return failOrb(task, deps, orb, "provider_failed", `project ${orb.projectId} not found`);
    }
    const provisioned = await withDeadline(
      task,
      deps.constants.providerOperationTimeoutMs,
      "provision host",
      (context) =>
        deps.hostProvider.provision(
          task,
          { orbId: orb.id, bootstrap: { repositoryUrl: project.repositoryUrl } },
          context,
        ),
    );
    if (provisioned.isErr()) {
      return provisioned.error.retryable
        ? retryable(provisioned.error.message)
        : failOrb(task, deps, orb, "provider_failed", provisioned.error.message);
    }
    const updated = await deps.store.casUpdateFields(task, {
      orbId: orb.id,
      expectedStateVersion: orb.stateVersion,
      now: task.wallNow(),
      hostRef: provisioned.value.ref.resourceId,
      runtimeTokenHash: provisioned.value.runtimeTokenHash,
    });
    if (updated.isErr()) {
      return updated.error.type === "state_conflict"
        ? { type: "conflict" }
        : retryable(updated.error.message);
    }
    orb = updated.value;
    hostResourceId = provisioned.value.ref.resourceId;
  }

  // 4. Drive the host toward a ready runtime.
  const observed = await observeHost(task, deps, hostResourceId);
  if (observed.isErr()) {
    return observed.error.retryable
      ? retryable(observed.error.message)
      : failOrb(task, deps, orb, "provider_failed", observed.error.message);
  }
  const observation = observed.value;
  if (observation === null) {
    // Definitive absence: idempotent provision restores the host (§5.2).
    const projectResult = await deps.store.getProject(task, orb.projectId);
    if (projectResult.isErr()) return retryable(projectResult.error.message);
    const project = projectResult.value;
    if (project === null) {
      return failOrb(task, deps, orb, "provider_failed", `project ${orb.projectId} not found`);
    }
    const provisioned = await withDeadline(
      task,
      deps.constants.providerOperationTimeoutMs,
      "re-provision absent host",
      (context) =>
        deps.hostProvider.provision(
          task,
          { orbId: orb.id, bootstrap: { repositoryUrl: project.repositoryUrl } },
          context,
        ),
    );
    if (provisioned.isErr()) {
      return provisioned.error.retryable
        ? retryable(provisioned.error.message)
        : failOrb(task, deps, orb, "provider_failed", provisioned.error.message);
    }
    if (
      provisioned.value.ref.resourceId !== hostResourceId ||
      provisioned.value.runtimeTokenHash !== orb.runtimeTokenHash
    ) {
      // A replaced host may keep its resource name (Docker container names
      // are stable) while carrying a fresh token, so the hash is compared
      // independently of the ref.
      const updated = await deps.store.casUpdateFields(task, {
        orbId: orb.id,
        expectedStateVersion: orb.stateVersion,
        now: task.wallNow(),
        hostRef: provisioned.value.ref.resourceId,
        runtimeTokenHash: provisioned.value.runtimeTokenHash,
      });
      if (updated.isErr()) {
        return updated.error.type === "state_conflict"
          ? { type: "conflict" }
          : retryable(updated.error.message);
      }
    }
    return { type: "progressed" };
  }

  switch (observation.state) {
    case "starting":
    case "stopping":
      deps.control.recordBootProbe(orb.id, {
        hostState: observation.state,
        hostRunningSinceWall: null,
        hostRunningSinceMono: null,
        answered: false,
      });
      return waiting("host_transition");
    case "stopped":
    case "failed": {
      const started = await startHost(task, deps, hostResourceId);
      if (started.isErr()) {
        return started.error.retryable
          ? retryable(started.error.message)
          : failOrb(task, deps, orb, "provider_failed", started.error.message);
      }
      return { type: "progressed" };
    }
    case "running": {
      const address = observation.runtimeAddress;
      const probeBase = {
        hostState: "running",
        hostRunningSinceWall: task.wallNow(),
        hostRunningSinceMono: task.monotonicNow(),
      };
      if (address === undefined) {
        deps.control.recordBootProbe(orb.id, {
          ...probeBase,
          answered: false,
          lastError: "host reports no runtime address",
        });
        return waiting("readiness");
      }
      const health = await withDeadline(
        task,
        deps.constants.runtimeRequestTimeoutMs,
        "readiness health check",
        (context) => deps.runtimeClient.health(task, address.baseUrl, context),
      );
      if (health.isErr()) {
        deps.control.recordBootProbe(orb.id, {
          ...probeBase,
          answered: false,
          lastError: health.error.message,
        });
        // Sub-deadline (DESIGN.md §5.2): the health server starts before slow
        // init, so a running host that has never answered is a boot failure,
        // not a slow clone — fail fast with host-side evidence.
        const probe = deps.control.getBootProbe(orb.id);
        const nowMono = task.monotonicNow();
        if (
          probe !== null &&
          !probe.everAnswered &&
          probe.hostRunningSinceMono !== null &&
          nowMono - probe.hostRunningSinceMono > deps.constants.unreachableBootDeadlineMs
        ) {
          const diagnosis = await diagnoseHost(task, deps, hostResourceId);
          if (!diagnosis.settled) return waiting("readiness");
          const seconds = Math.round((nowMono - probe.hostRunningSinceMono) / 1000);
          const evidence = diagnosis.evidence;
          return failOrbStoppingHost(
            task,
            deps,
            orb,
            "runtime_never_answered",
            `host ran for ${seconds}s but the runtime never answered ` +
              `(${probe.attempts} probes; last error: ${health.error.message})` +
              (evidence !== null && evidence !== "" ? `; host diagnostics: ${evidence}` : ""),
          );
        }
        return waiting("readiness");
      }
      deps.control.recordBootProbe(orb.id, { ...probeBase, answered: true });
      const status = health.value;
      if (status.status === "initializing") return waiting("readiness");
      if (status.status === "failed") {
        if (status.error.retryable) return waiting("readiness");
        return failOrbStoppingHost(
          task,
          deps,
          orb,
          "runtime_failed",
          `${status.error.code}: ${status.error.message}`,
        );
      }
      if (status.orbId !== orb.id) {
        return failOrbStoppingHost(
          task,
          deps,
          orb,
          "runtime_failed",
          `runtime identity mismatch: expected ${orb.id}, got ${status.orbId}`,
        );
      }
      // Persist ready identity before the orb becomes running (§5.2).
      const updated = await deps.store.casUpdateFields(task, {
        orbId: orb.id,
        expectedStateVersion: orb.stateVersion,
        now: task.wallNow(),
        checkoutCommit: status.checkoutCommit,
        hostRef: hostResourceId,
      });
      if (updated.isErr()) {
        return updated.error.type === "state_conflict"
          ? { type: "conflict" }
          : retryable(updated.error.message);
      }
      deps.control.clearBootProbe(orb.id);
      const transitioned = await transitionTo(task, deps, updated.value, "running", {
        lastError: null,
      });
      if (transitioned.type === "transitioned") {
        deps.control.resetLivenessBaseline(orb.id, task.monotonicNow());
      }
      return transitioned;
    }
  }
}

// ---------------------------------------------------------------------------
// running

async function reconcileRunning(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orb: OrbRow,
): Promise<ReconcileOutcome> {
  if (orb.hostRef === null) {
    return transitionTo(task, deps, orb, "starting");
  }
  const observed = await observeHost(task, deps, orb.hostRef);
  if (observed.isErr()) {
    return observed.error.retryable
      ? retryable(observed.error.message)
      : failOrb(task, deps, orb, "provider_failed", observed.error.message);
  }
  const observation = observed.value;
  if (observation === null || observation.state === "stopped" || observation.state === "failed") {
    // Unexpected absence/stop: restore the host around the retained
    // filesystem (DESIGN.md §5.2).
    return transitionTo(task, deps, orb, "starting");
  }
  if (observation.state === "starting" || observation.state === "stopping") {
    return waiting("host_transition");
  }
  // Host running: derive runtime liveness from the history pull.
  const liveness = deps.control.getLiveness(orb.id);
  if (liveness === null) {
    // Fresh process (control-plane restart): seed the baseline now.
    deps.control.resetLivenessBaseline(orb.id, task.monotonicNow());
    return { type: "noop" };
  }
  if (task.monotonicNow() - liveness.lastSuccessAt > deps.constants.unreachableGraceMs) {
    deps.control.markRestartPending(orb.id);
    const stopped = await stopHost(task, deps, orb.hostRef);
    if (stopped.isErr()) {
      return stopped.error.retryable
        ? retryable(stopped.error.message)
        : failOrb(task, deps, orb, "provider_failed", stopped.error.message);
    }
    const started = await startHost(task, deps, orb.hostRef);
    if (started.isErr()) {
      return started.error.retryable
        ? retryable(started.error.message)
        : failOrb(task, deps, orb, "provider_failed", started.error.message);
    }
    deps.control.clearRestartPending(orb.id);
    deps.control.resetLivenessBaseline(orb.id, task.monotonicNow());
    return { type: "progressed" };
  }

  // Idle auto-stop (DESIGN.md §3.4). Only a tab that affirmatively reports
  // itself visible counts as activity; hidden and non-reporting connections
  // do not, so a lost presence frame fails toward an earlier stop, never a
  // leaked host. The last pull's `busy` observation also blocks the stop:
  // wall time may leap past the deadline (clock jump, paused process) faster
  // than pulls can refresh the persisted timestamp.
  const now = task.wallNow();
  const lastActivityAt = Math.max(
    orb.lastBusyAt ?? 0,
    orb.stateChangedAt,
    deps.control.getLastVisibleAt(orb.id) ?? 0,
  );
  if (liveness.activity === "busy" || deps.control.hasVisibleBrowser(orb.id)) {
    if (now - lastActivityAt > deps.constants.idleStopAfterMs / 2) {
      // Keep the persisted timestamp fresh enough that a control-plane
      // restart under a watched orb cannot trigger an immediate idle stop.
      await deps.store.touchLastBusy(task, { orbId: orb.id, now });
    }
    return { type: "noop" };
  }
  if (now - lastActivityAt > deps.constants.idleStopAfterMs) {
    const transitioned = await transitionTo(task, deps, orb, "stopping", { stopReason: "idle" });
    if (transitioned.type === "transitioned") deps.control.markStopping(orb.id);
    return transitioned;
  }
  return { type: "noop" };
}

// ---------------------------------------------------------------------------
// stopping

async function reconcileStopping(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orb: OrbRow,
): Promise<ReconcileOutcome> {
  // New live connections are rejected while stopping (DESIGN.md §5.2).
  deps.control.markStopping(orb.id);

  if (orb.hostRef === null) {
    // Nothing was ever provisioned; nothing to drain or stop.
    return transitionTo(task, deps, orb, "stopped");
  }
  const observed = await observeHost(task, deps, orb.hostRef);
  if (observed.isErr()) {
    return observed.error.retryable
      ? retryable(observed.error.message)
      : failOrb(task, deps, orb, "provider_failed", observed.error.message);
  }
  const observation = observed.value;
  if (observation === null || observation.state === "stopped" || observation.state === "failed") {
    // A host we stopped ourselves as half of an unreachable-runtime restart
    // is not "already stopped": complete the restart so the drain can finish.
    if (observation !== null && deps.control.isRestartPending(orb.id)) {
      const started = await startHost(task, deps, orb.hostRef);
      if (started.isErr()) return retryable(started.error.message);
      deps.control.clearRestartPending(orb.id);
      deps.control.resetLivenessBaseline(orb.id, task.monotonicNow());
      return { type: "progressed" };
    }
    // Absent or already-stopped host: no runtime to drain; complete records
    // left on the persistent filesystem are found on the next start (§5.2).
    if (observation !== null && observation.state === "failed") {
      await stopHost(task, deps, orb.hostRef);
    }
    return transitionTo(task, deps, orb, "stopped");
  }
  if (observation.state === "starting" || observation.state === "stopping") {
    return waiting("host_transition");
  }

  // Host is running.
  if (hasNeverBeenReady(orb)) {
    // Never reached ready and has no session: no user request could have been
    // accepted, so the drain is skipped (§5.2).
    const stopped = await stopHost(task, deps, orb.hostRef);
    if (stopped.isErr()) {
      return stopped.error.retryable
        ? retryable(stopped.error.message)
        : failOrb(task, deps, orb, "provider_failed", stopped.error.message);
    }
    return transitionTo(task, deps, orb, "stopped");
  }

  // A drain stuck longer than the create/start deadline cannot be completed
  // by waiting: the runtime cannot be restored to ready (§5.2).
  if (task.wallNow() - orb.stateChangedAt > deps.constants.createStartDeadlineMs) {
    return failOrbStoppingHost(
      task,
      deps,
      orb,
      "drain_runtime_unrecoverable",
      "history drain could not complete within the create/start deadline",
    );
  }

  // The unreachable-runtime restart applies during stopping too, so a pending
  // drain is never stranded behind a dead runtime process (§5.2).
  const liveness = deps.control.getLiveness(orb.id);
  if (liveness === null) {
    deps.control.resetLivenessBaseline(orb.id, task.monotonicNow());
  } else if (task.monotonicNow() - liveness.lastSuccessAt > deps.constants.unreachableGraceMs) {
    deps.control.markRestartPending(orb.id);
    const stopped = await stopHost(task, deps, orb.hostRef);
    if (stopped.isErr()) return retryable(stopped.error.message);
    const started = await startHost(task, deps, orb.hostRef);
    if (started.isErr()) return retryable(started.error.message);
    deps.control.clearRestartPending(orb.id);
    deps.control.resetLivenessBaseline(orb.id, task.monotonicNow());
    return { type: "progressed" };
  }

  // The controlled-shutdown pull barrier (DESIGN.md §8.4).
  const outcome = await pollOrbUntilCaughtUp(task, deps, orb.id);
  switch (outcome.type) {
    case "caught_up": {
      deps.control.setDrainStatus(orb.id, { retrying: false });
      const stopped = await stopHost(task, deps, orb.hostRef);
      if (stopped.isErr()) {
        return stopped.error.retryable
          ? retryable(stopped.error.message)
          : failOrb(task, deps, orb, "provider_failed", stopped.error.message);
      }
      return transitionTo(task, deps, orb, "stopped");
    }
    case "retryable":
      // The stop must not proceed; the host stays running while we retry.
      deps.control.setDrainStatus(orb.id, { retrying: true, message: outcome.message });
      return waiting("drain_blocked");
    case "integrity":
      // Already stopped the host and failed the orb inside the poll.
      return { type: "transitioned", toState: "failed" };
    case "orb_gone":
      return { type: "conflict" };
  }
}

// ---------------------------------------------------------------------------
// stopped / failed backstop

async function reconcileTerminalBackstop(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orb: OrbRow,
): Promise<ReconcileOutcome> {
  if (orb.hostRef === null) return { type: "noop" };
  const observed = await observeHost(task, deps, orb.hostRef);
  if (observed.isErr()) return retryable(observed.error.message);
  const observation = observed.value;
  if (observation === null || observation.state === "stopped") return { type: "noop" };
  if (observation.state === "stopping") return waiting("host_transition");
  const stopped = await stopHost(task, deps, orb.hostRef);
  if (stopped.isErr()) return retryable(stopped.error.message);
  return { type: "progressed" };
}

// ---------------------------------------------------------------------------

export async function reconcileOrbOnce(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orbId: string,
): Promise<ReconcileOutcome> {
  const orbResult = await deps.store.getOrb(task, orbId);
  if (orbResult.isErr()) return retryable(orbResult.error.message);
  const orb = orbResult.value;
  if (orb === null) return { type: "noop" };
  switch (orb.state) {
    case "creating":
    case "starting":
      return reconcileCreateStart(task, deps, orb);
    case "running":
      return reconcileRunning(task, deps, orb);
    case "stopping":
      return reconcileStopping(task, deps, orb);
    case "stopped":
    case "failed":
      return reconcileTerminalBackstop(task, deps, orb);
  }
}

// ---------------------------------------------------------------------------
// Commands (DESIGN.md §5.2)

export interface CommandError {
  readonly type: "command_error";
  readonly code: "not_found" | "conflict" | "unavailable";
  readonly message: string;
  readonly retryable: boolean;
}

const CAS_ATTEMPTS = 5;

function commandError(
  code: CommandError["code"],
  message: string,
  retryable_: boolean,
): CommandError {
  return { type: "command_error", code, message, retryable: retryable_ };
}

function mapCasError(error: StoreError | StateConflict): CommandError {
  return error.type === "state_conflict"
    ? commandError("conflict", "concurrent state change", true)
    : commandError("unavailable", error.message, error.retryable);
}

/** Create inserts `creating` (DESIGN.md §11.3: creation also requests start). */
export function createOrb(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  params: { orbId: string; projectId: string },
): ResultAsync<OrbRow, CommandError> {
  const run = async (): Promise<Result<OrbRow, CommandError>> => {
    const projectResult = await deps.store.getProject(task, params.projectId);
    if (projectResult.isErr()) {
      return err(commandError("unavailable", projectResult.error.message, true));
    }
    if (projectResult.value === null) {
      return err(commandError("not_found", `project ${params.projectId} not found`, false));
    }
    const existing = await deps.store.getOrb(task, params.orbId);
    if (existing.isErr()) return err(commandError("unavailable", existing.error.message, true));
    if (existing.value !== null) {
      if (existing.value.projectId !== params.projectId) {
        return err(commandError("conflict", "orb id exists with different content", false));
      }
      return ok(existing.value);
    }
    const now = task.wallNow();
    const row: OrbRow = {
      id: params.orbId,
      projectId: params.projectId,
      state: "creating",
      stateVersion: 0,
      hostKind: deps.hostProvider.kind,
      hostRef: null,
      checkoutCommit: null,
      harnessSessionId: null,
      harnessSessionHeader: null,
      lastError: null,
      runtimeTokenHash: null,
      replicationCursor: null,
      replicatedHeadId: null,
      lastBusyAt: null,
      stopReason: null,
      stateChangedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const inserted = await deps.store.insertOrb(task, row);
    if (inserted.isErr()) return err(commandError("unavailable", inserted.error.message, true));
    return ok(inserted.value);
  };
  return new ResultAsync(run());
}

/**
 * Idempotent for creating/starting/running; from stopped/failed it clears
 * last_error and enters starting; 409 while stopping.
 */
export function requestOrbStart(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orbId: string,
): ResultAsync<OrbRow, CommandError> {
  const run = async (): Promise<Result<OrbRow, CommandError>> => {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const orbResult = await deps.store.getOrb(task, orbId);
      if (orbResult.isErr()) return err(commandError("unavailable", orbResult.error.message, true));
      const orb = orbResult.value;
      if (orb === null) return err(commandError("not_found", `orb ${orbId} not found`, false));
      switch (orb.state) {
        case "creating":
        case "starting":
        case "running":
          return ok(orb);
        case "stopping":
          return err(commandError("conflict", "orb is stopping; retry after it has stopped", true));
        case "stopped":
        case "failed": {
          const cas = await deps.store.casTransition(task, {
            orbId,
            expectedStateVersion: orb.stateVersion,
            toState: "starting",
            now: task.wallNow(),
            lastError: null,
            stopReason: null,
          });
          if (cas.isOk()) return ok(cas.value);
          if (cas.error.type === "state_conflict") continue;
          return err(mapCasError(cas.error));
        }
      }
    }
    return err(commandError("conflict", "concurrent state changes; retry", true));
  };
  return new ResultAsync(run());
}

/** Idempotent for stopping/stopped; everything else enters stopping. */
export function requestOrbStop(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orbId: string,
): ResultAsync<OrbRow, CommandError> {
  const run = async (): Promise<Result<OrbRow, CommandError>> => {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const orbResult = await deps.store.getOrb(task, orbId);
      if (orbResult.isErr()) return err(commandError("unavailable", orbResult.error.message, true));
      const orb = orbResult.value;
      if (orb === null) return err(commandError("not_found", `orb ${orbId} not found`, false));
      if (orb.state === "stopping" || orb.state === "stopped") return ok(orb);
      const cas = await deps.store.casTransition(task, {
        orbId,
        expectedStateVersion: orb.stateVersion,
        toState: "stopping",
        now: task.wallNow(),
        // An explicit stop presents no reason, including over a stale one.
        stopReason: null,
      });
      if (cas.isOk()) {
        deps.control.markStopping(orbId);
        return ok(cas.value);
      }
      if (cas.error.type === "state_conflict") continue;
      return err(mapCasError(cas.error));
    }
    return err(commandError("conflict", "concurrent state changes; retry", true));
  };
  return new ResultAsync(run());
}

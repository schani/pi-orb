import type { MessageInputBlock, OrbState, RuntimeHooks, StopReason } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import type { LivenessEntry } from "./control-state.ts";
import { withDeadline } from "./dst.ts";
import {
  formatOrbFailure,
  type OrbFailureCode,
  type OrbHostProviderError,
  type StateConflict,
  type StoreError,
} from "./errors.ts";
import { logOrbEvent } from "./log.ts";
import {
  type BootHook,
  type BootHookFailureReason,
  hasNeverBeenReady,
  type OrbMessageRow,
  type OrbRow,
} from "./orb.ts";
import type {
  ControlPlaneDeps,
  OrbHostObservation,
  OrbHostRef,
  ProvisionedOrbHost,
} from "./ports.ts";
import { pollOrbUntilCaughtUp } from "./replication.ts";

export type ReconcileOutcome =
  | { readonly type: "noop" }
  | {
      readonly type: "waiting";
      readonly reason:
        | "auth"
        | "readiness"
        | "host_transition"
        | "stale_compute_disposal"
        | "drain_blocked"
        | "deletion_quarantine";
    }
  | { readonly type: "progressed" }
  | { readonly type: "transitioned"; readonly toState: OrbState }
  | {
      readonly type: "retryable";
      readonly message: string;
      /**
       * The failure reached the retry channel but no retry can clear it: a
       * `StoreError` with code `invariant`, i.e. our own SQL or parameter
       * encoding is wrong (docs/lifecycle.md). The loops log it once and stop
       * re-attempting this orb instead of spinning until someone deploys a fix.
       */
      readonly invariant?: boolean;
    }
  | { readonly type: "conflict" };

/** Failure carried by the retry channel; `invariant` propagates from a `StoreError`. */
type RetryableSource =
  | string
  | { readonly message: string; readonly code?: string; readonly invariant?: boolean };

const retryable = (source: RetryableSource): ReconcileOutcome => {
  if (typeof source === "string") return { type: "retryable", message: source };
  return source.code === "invariant" || source.invariant === true
    ? { type: "retryable", message: source.message, invariant: true }
    : { type: "retryable", message: source.message };
};
const waiting = (
  reason:
    | "auth"
    | "readiness"
    | "host_transition"
    | "stale_compute_disposal"
    | "drain_blocked"
    | "deletion_quarantine",
) => ({ type: "waiting", reason }) as const;

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

/**
 * The boot-hook failure the orb page reports, setup before resume: a setup
 * that did not run is the more useful explanation of a broken environment,
 * and one line is all the banner has room for.
 */
function firstHookFailure(
  hooks: RuntimeHooks | undefined,
): { hook: BootHook; reason: BootHookFailureReason; logPath: string } | null {
  for (const status of [hooks?.setup, hooks?.resume]) {
    if (status === undefined || status.outcome === "ok") continue;
    return { hook: status.hook, reason: status.outcome, logPath: status.logPath };
  }
  return null;
}

/**
 * Whether this boot's ordinary deadline is currently held off by a running
 * `.agents/setup` (docs/orb-setup-hook.md). Bounded by `setupHookHoldMs`: a
 * runtime that claims setup for longer than its own deadline plus room to
 * finish is stuck, and gets the ordinary treatment.
 */
function holdingForSetupHook(task: SimulationTask, deps: ControlPlaneDeps, orbId: string): boolean {
  const probe = deps.control.getBootProbe(orbId);
  if (probe === null || probe.setupRunningSinceMono === null) return false;
  const now = task.monotonicNow();
  if (now - probe.setupRunningSinceMono > deps.constants.setupHookHoldMs) return false;
  // And only while there is still a runtime to hold for: a runtime silent this
  // long is gone, and without this the hold would hide that for twenty
  // minutes — the "silence looks like progress" failure the readiness path
  // exists to prevent. The grace is the boot-sized one, not the ordinary
  // unreachable grace: readiness probes during a boot contend with slow
  // provider observes and are routinely cancelled in bursts, and ending a
  // legitimate twenty-minute setup over a burst of cancellations would be the
  // 2026-08-05 livelock's mistake in a new place (docs/lifecycle.md).
  return (
    probe.lastAnswerMono !== null && now - probe.lastAnswerMono <= deps.constants.postRestartGraceMs
  );
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

/**
 * Every provider stop/start/provision the reconciler issues is a decision an
 * incident needs to see, so all three go through helpers that log exactly one
 * line each — the operation, the orb, the host, why it was issued, and the
 * provider's answer when it failed (docs/lifecycle.md, learned from
 * `docs/postmortems/2026-08-05-unreachable-restart-livelock.md`, where 38
 * stop/start cycles were invisible to the control plane's own logs).
 */
async function stopHost(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orbId: string,
  resourceId: string,
  reason: string,
): Promise<Result<void, OrbHostProviderError>> {
  const result = await withDeadline(
    task,
    deps.constants.providerOperationTimeoutMs,
    "stop host",
    (context) => deps.hostProvider.stop(task, hostRefOf(deps, resourceId), context),
  );
  logOrbEvent(task, orbId, "host-stop", {
    host: resourceId,
    reason,
    ...(result.isErr()
      ? { error: result.error.message, retryable: result.error.retryable }
      : { outcome: "ok" }),
  });
  return result;
}

async function destroyHost(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orbId: string,
): Promise<Result<void, OrbHostProviderError>> {
  const result = await withDeadline(
    task,
    deps.constants.providerOperationTimeoutMs,
    "destroy host",
    (context) => deps.hostProvider.destroy(task, orbId, context),
  );
  logOrbEvent(task, orbId, "host-destroy", {
    ...(result.isErr()
      ? { error: result.error.message, retryable: result.error.retryable }
      : { outcome: "absent" }),
  });
  return result;
}

async function startHost(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orbId: string,
  resourceId: string,
  expectedIncarnation: number,
  expectedSpecFingerprint: string | null,
  reason: string,
): Promise<Result<void, OrbHostProviderError>> {
  const result = await withDeadline(
    task,
    deps.constants.providerOperationTimeoutMs,
    "start host",
    (context) =>
      deps.hostProvider.start(
        task,
        { ref: hostRefOf(deps, resourceId), expectedIncarnation, expectedSpecFingerprint },
        context,
      ),
  );
  logOrbEvent(task, orbId, "host-start", {
    host: resourceId,
    reason,
    ...(result.isErr()
      ? { error: result.error.message, retryable: result.error.retryable }
      : { outcome: "ok" }),
  });
  return result;
}

/**
 * Idempotent provision (docs/host-provider.md). The logged `outcome` is the
 * control plane's view, which is all it can know: `created` when no host was
 * recorded, `adopted` when the provider handed back the recorded one, and
 * `replaced` when the ref changed under us.
 */
async function provisionHost(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orb: OrbRow,
  repositoryUrl: string,
  reason: string,
): Promise<Result<ProvisionedOrbHost, OrbHostProviderError>> {
  const result = await withDeadline(
    task,
    deps.constants.providerOperationTimeoutMs,
    "provision host",
    (context) =>
      deps.hostProvider.provision(
        task,
        { orbId: orb.id, incarnation: orb.hostIncarnation, bootstrap: { repositoryUrl } },
        context,
      ),
  );
  if (result.isErr()) {
    logOrbEvent(task, orb.id, "provision", {
      reason,
      error: result.error.message,
      retryable: result.error.retryable,
    });
    return result;
  }
  if (result.value.incarnation !== orb.hostIncarnation) {
    return err({
      type: "orb_host_provider_error",
      provider: deps.hostProvider.kind,
      operation: "provision",
      code: "conflict",
      message: `provider returned incarnation ${result.value.incarnation}, expected ${orb.hostIncarnation}`,
      retryable: false,
    });
  }
  const resourceId = result.value.ref.resourceId;
  logOrbEvent(task, orb.id, "provision", {
    host: resourceId,
    reason,
    outcome: orb.hostRef === null ? "created" : orb.hostRef === resourceId ? "adopted" : "replaced",
    ...(orb.runtimeTokenHash !== null && orb.runtimeTokenHash !== result.value.runtimeTokenHash
      ? { token_rotated: true }
      : {}),
  });
  return result;
}

function boundedDiscardText(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").slice(0, 2_000);
}

/**
 * Bounded best-effort host diagnosis for terminal/discard evidence. Diagnosis
 * failure is itself durable evidence, never a reason to preserve suspect
 * compute or defer a terminal decision.
 */
async function collectDiscardEvidence(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  hostRef: string | null,
  reason: string,
): Promise<string> {
  if (hostRef === null) return "diagnosis unavailable: no compute reference";
  const diagnose = deps.hostProvider.diagnose?.bind(deps.hostProvider);
  if (diagnose === undefined) return "diagnosis unavailable: provider does not support diagnosis";
  const diagnosed = await withDeadline(
    task,
    deps.constants.providerOperationTimeoutMs,
    reason,
    (context) => diagnose(task, hostRefOf(deps, hostRef), context),
  );
  return diagnosed.isOk()
    ? diagnosed.value === null || diagnosed.value === ""
      ? "diagnosis unavailable: provider returned no evidence"
      : boundedDiscardText(diagnosed.value)
    : `diagnosis unavailable: ${boundedDiscardText(diagnosed.error.message)}`;
}

/** CAS the orb to `failed` and atomically invalidate its compute incarnation. */
async function failOrb(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orb: OrbRow,
  code: OrbFailureCode,
  message: string,
  evidence?: string | null,
): Promise<ReconcileOutcome> {
  // Terminal diagnosis must precede the failure/discard transaction: after it
  // commits, another reconciler is entitled to delete the compute immediately.
  const terminalEvidence =
    evidence !== undefined
      ? evidence
      : await collectDiscardEvidence(task, deps, orb.hostRef, "diagnose terminal failure");
  const boundedEvidence = boundedDiscardText(
    terminalEvidence ?? "diagnosis unavailable: no evidence supplied",
  );
  const failureMessage =
    boundedEvidence.startsWith("diagnosis unavailable:") || message.includes(boundedEvidence)
      ? message
      : `${message}; host_evidence: ${boundedEvidence}`;
  const cas = await deps.store.failOrbAndRequestComputeDiscard(task, {
    orbId: orb.id,
    expectedStateVersion: orb.stateVersion,
    now: task.wallNow(),
    lastError: formatOrbFailure(code, failureMessage),
    evidence: boundedEvidence,
  });
  if (cas.isErr()) {
    return cas.error.type === "state_conflict" ? { type: "conflict" } : retryable(cas.error);
  }
  await task.checkpoint("compute-replacement.failure-intent-committed");
  logOrbEvent(task, orb.id, "transition", {
    from: orb.state,
    to: "failed",
    code,
    error: message,
  });
  logOrbEvent(task, orb.id, "compute-discard-requested", {
    host: orb.hostRef,
    through_incarnation: orb.hostIncarnation,
    reason: "failed",
    failure_code: code,
  });
  deps.control.clearOrb(orb.id);
  return { type: "transitioned", toState: "failed" };
}

async function failOnObservationMismatch(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orb: OrbRow,
  observation: OrbHostObservation | null,
): Promise<ReconcileOutcome | null> {
  if (
    observation === null ||
    (observation.orbId === orb.id && observation.incarnation === orb.hostIncarnation)
  ) {
    return null;
  }
  return failOrb(
    task,
    deps,
    orb,
    "provider_failed",
    `host identity mismatch: observed orb=${observation.orbId} incarnation=${observation.incarnation}, ` +
      `expected orb=${orb.id} incarnation=${orb.hostIncarnation}`,
  );
}

/**
 * Reconcile one durable compute-discard intent before any state-specific host
 * work. Provider absence is not enough: finalization advances the incarnation
 * only after the adapter has verified every resource through the fence absent.
 */
async function reconcileHostDiscard(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orb: OrbRow,
): Promise<ReconcileOutcome> {
  const through = orb.hostDiscardThroughIncarnation;
  if (through === null) return { type: "noop" };

  let evidence = orb.hostDiscardEvidence;
  if (evidence === null && orb.hostRef !== null && deps.hostProvider.diagnose !== undefined) {
    evidence = await collectDiscardEvidence(
      task,
      deps,
      orb.hostRef,
      "diagnose before compute discard",
    );
    const recorded = await deps.store.recordHostDiscardStatus(task, {
      orbId: orb.id,
      throughIncarnation: through,
      now: task.wallNow(),
      evidence,
    });
    if (recorded.isErr()) return retryable(recorded.error);
  }

  await task.checkpoint("compute-replacement.discard-before-provider");
  const discarded = await withDeadline(
    task,
    deps.constants.providerOperationTimeoutMs,
    "discard compute",
    (context) =>
      deps.hostProvider.discardCompute(
        task,
        { orbId: orb.id, throughIncarnation: through },
        context,
      ),
  );
  await task.checkpoint("compute-replacement.discard-after-provider");
  if (discarded.isErr()) {
    const message = boundedDiscardText(discarded.error.message);
    const recorded = await deps.store.recordHostDiscardStatus(task, {
      orbId: orb.id,
      throughIncarnation: through,
      now: task.wallNow(),
      error: message,
    });
    if (recorded.isErr()) return retryable(recorded.error);
    // The durable error column is the edge authority: it survives process
    // restarts and never re-logs the same persisting condition per pass.
    if (orb.hostDiscardError !== message) {
      logOrbEvent(task, orb.id, "compute-discard", {
        host: orb.hostRef,
        through_incarnation: through,
        outcome: "error",
        error: message,
        evidence,
      });
    }
    return retryable(discarded.error);
  }

  await task.checkpoint("compute-replacement.discard-before-finalize");
  const finalized = await deps.store.finalizeHostDiscard(task, {
    orbId: orb.id,
    expectedStateVersion: orb.stateVersion,
    throughIncarnation: through,
    now: task.wallNow(),
  });
  if (finalized.isErr()) {
    return finalized.error.type === "state_conflict"
      ? { type: "conflict" }
      : retryable(finalized.error);
  }
  await task.checkpoint("compute-replacement.discard-finalized");
  // Recovery is an edge only once: finalization clears the durable error, so
  // no later pass can observe it again. Logging recovery before finalization
  // repeated the edge on every finalize retry after a successful discard.
  if (orb.hostDiscardError !== null) {
    logOrbEvent(task, orb.id, "compute-discard-recovered", {
      through_incarnation: through,
    });
  }
  logOrbEvent(task, orb.id, "compute-discard", {
    host: orb.hostRef,
    through_incarnation: through,
    outcome: "ok",
    evidence,
  });
  return { type: "progressed" };
}

async function transitionTo(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orb: OrbRow,
  toState: OrbState,
  extra?: {
    lastError?: string | null;
    stopReason?: StopReason | null;
    /** Log-only: why the reconciler decided on this transition. */
    reason?: string;
  },
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
    return cas.error.type === "state_conflict" ? { type: "conflict" } : retryable(cas.error);
  }
  logOrbEvent(task, orb.id, "transition", {
    from: orb.state,
    to: toState,
    reason: extra?.reason,
    stop_reason: extra?.stopReason,
  });
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

  // Immutable specification is evaluated only in the ordinary create/start
  // path: deploys neither sweep stopped compute nor bounce running orbs.
  const projectResult = await deps.store.getProject(task, orb.projectId);
  if (projectResult.isErr()) return retryable(projectResult.error);
  const project = projectResult.value;
  if (project === null) {
    return failOrb(task, deps, orb, "provider_failed", `project ${orb.projectId} not found`);
  }
  const desiredSpecFingerprint = deps.hostProvider.desiredSpecFingerprint({
    orbId: orb.id,
    repositoryUrl: project.repositoryUrl,
  });
  const declinedCondition = `spec-replacement-declined:${orb.id}`;
  let startSpecFingerprint = desiredSpecFingerprint;
  if (
    orb.hostRef === null &&
    orb.hostSpecFingerprint !== null &&
    orb.hostSpecFingerprint !== desiredSpecFingerprint &&
    deps.hostProvider.specGeneration < (orb.hostSpecGeneration ?? 0)
  ) {
    if (deps.control.noteCondition(declinedCondition, true)) {
      logOrbEvent(task, orb.id, "spec-replacement-declined", {
        committed_generation: orb.hostSpecGeneration ?? 0,
        configured_generation: deps.hostProvider.specGeneration,
      });
    }
    return waiting("stale_compute_disposal");
  }
  if (orb.hostRef !== null && orb.hostSpecFingerprint !== desiredSpecFingerprint) {
    const requested = await deps.store.requestHostSpecReplacement(task, {
      orbId: orb.id,
      expectedStateVersion: orb.stateVersion,
      desiredFingerprint: desiredSpecFingerprint,
      configuredGeneration: deps.hostProvider.specGeneration,
      now: task.wallNow(),
    });
    if (requested.isErr()) {
      return requested.error.type === "state_conflict"
        ? { type: "conflict" }
        : retryable(requested.error);
    }
    if (requested.value.type === "requested") {
      deps.control.noteCondition(declinedCondition, false);
      logOrbEvent(task, orb.id, "compute-discard-requested", {
        host: orb.hostRef,
        through_incarnation: orb.hostIncarnation,
        reason: "host_spec_changed",
      });
      return waiting("stale_compute_disposal");
    }
    if (requested.value.type === "declined") {
      startSpecFingerprint = orb.hostSpecFingerprint ?? desiredSpecFingerprint;
      if (deps.control.noteCondition(declinedCondition, true)) {
        logOrbEvent(task, orb.id, "spec-replacement-declined", {
          committed_generation: requested.value.committedGeneration,
          configured_generation: deps.hostProvider.specGeneration,
        });
      }
    } else {
      deps.control.noteCondition(declinedCondition, false);
    }
  } else {
    deps.control.noteCondition(declinedCondition, false);
  }

  // 1. Codex auth is a prerequisite for host work (docs/credentials.md).
  const auth = await deps.authGate.ensureAuth(task);
  if (auth.isErr()) return retryable(auth.error);
  const resolution = auth.value;
  if (resolution.status === "pending") {
    // Edge only: the readiness poll re-enters this branch every few seconds
    // for as long as the user takes to log in.
    if (!deps.control.isAuthBlocked(orb.id)) {
      logOrbEvent(task, orb.id, "auth-blocked", { reason: "device_login_pending" });
    }
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
    // never consumes the create/start deadline (docs/lifecycle.md).
    const reentered = await deps.store.casReenterState(task, {
      orbId: orb.id,
      expectedStateVersion: orb.stateVersion,
      now: task.wallNow(),
    });
    if (reentered.isErr()) {
      return reentered.error.type === "state_conflict"
        ? { type: "conflict" }
        : retryable(reentered.error);
    }
    deps.control.clearAuthBlocked(orb.id);
    logOrbEvent(task, orb.id, "auth-resolved", { reason: "state_reentered" });
    orb = reentered.value;
  }

  // 2. Create/start deadline (docs/lifecycle.md deadline_exceeded rule), held
  // off while the repository's setup hook is running (docs/orb-setup-hook.md).
  // The hold is anchored at the first `setup_running` report of the episode
  // and covers the hook plus the boot that follows it; it survives a single
  // cancelled probe, and ends on its own bound or on a runtime that has gone
  // properly silent. See `holdingForSetupHook`.
  if (
    !holdingForSetupHook(task, deps, orb.id) &&
    task.wallNow() - orb.stateChangedAt > deps.constants.createStartDeadlineMs
  ) {
    return failOrb(
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
    const isReplacement = orb.hostIncarnation > 0;
    if (isReplacement) {
      await task.checkpoint("compute-replacement.replacement-before-provision");
    }
    const provisioned = await provisionHost(task, deps, orb, project.repositoryUrl, "no_host_ref");
    if (provisioned.isErr()) {
      if (provisioned.error.retryable) return retryable(provisioned.error);
      // A conflict here is a racing revision, not a broken orb: the winner's
      // compute exists but its commit may not have landed yet, so a failOrb
      // CAS could still succeed and discard the winner's fresh compute.
      // Re-read and reconcile instead; the durable spec/incarnation logic
      // owns any surviving mismatch (docs/compute-replacement.md).
      if (provisioned.error.code === "conflict") return { type: "conflict" };
      return failOrb(task, deps, orb, "provider_failed", provisioned.error.message);
    }
    if (isReplacement) {
      await task.checkpoint("compute-replacement.replacement-after-provision");
      await task.checkpoint("compute-replacement.replacement-before-commit");
    }
    const updated = await deps.store.casUpdateFields(task, {
      orbId: orb.id,
      expectedStateVersion: orb.stateVersion,
      now: task.wallNow(),
      hostRef: provisioned.value.ref.resourceId,
      runtimeTokenHash: provisioned.value.runtimeTokenHash,
      // The durable stamp must describe the compute that actually exists, so
      // it is always the provider's answer — never the fingerprint pre-written
      // at request time, which a different revision may have committed.
      hostSpecFingerprint: provisioned.value.specFingerprint,
      hostSpecGeneration: provisioned.value.specGeneration,
      // Replacement succeeded: the retained discard evidence has served its
      // purpose and must not shadow a later, unrelated incident.
      hostDiscardEvidence: null,
    });
    if (updated.isErr()) {
      return updated.error.type === "state_conflict"
        ? { type: "conflict" }
        : retryable(updated.error);
    }
    orb = updated.value;
    hostResourceId = provisioned.value.ref.resourceId;
    if (isReplacement) {
      await task.checkpoint("compute-replacement.replacement-committed");
      logOrbEvent(task, orb.id, "replacement-provisioned", {
        host: hostResourceId,
        incarnation: provisioned.value.incarnation,
        spec: provisioned.value.specFingerprint.slice(0, 12),
      });
    }
  }

  // 4. Drive the host toward a ready runtime.
  const observed = await observeHost(task, deps, hostResourceId);
  if (observed.isErr()) {
    return observed.error.retryable
      ? retryable(observed.error)
      : failOrb(task, deps, orb, "provider_failed", observed.error.message);
  }
  const observation = observed.value;
  const identityFailure = await failOnObservationMismatch(task, deps, orb, observation);
  if (identityFailure !== null) return identityFailure;
  if (observation !== null && observation.specFingerprint !== startSpecFingerprint) {
    const replacement = await deps.store.requestHostSpecReplacement(task, {
      orbId: orb.id,
      expectedStateVersion: orb.stateVersion,
      desiredFingerprint: desiredSpecFingerprint,
      configuredGeneration: deps.hostProvider.specGeneration,
      force: true,
      now: task.wallNow(),
    });
    if (replacement.isErr()) {
      return replacement.error.type === "state_conflict"
        ? { type: "conflict" }
        : retryable(replacement.error);
    }
    if (replacement.value.type === "requested") {
      logOrbEvent(task, orb.id, "compute-discard-requested", {
        host: orb.hostRef,
        through_incarnation: orb.hostIncarnation,
        reason: "host_spec_changed",
      });
      return waiting("stale_compute_disposal");
    }
    if (replacement.value.type === "declined") {
      startSpecFingerprint = observation.specFingerprint ?? startSpecFingerprint;
      if (deps.control.noteCondition(declinedCondition, true)) {
        logOrbEvent(task, orb.id, "spec-replacement-declined", {
          committed_generation: replacement.value.committedGeneration,
          configured_generation: deps.hostProvider.specGeneration,
        });
      }
    }
  }
  if (observation === null) {
    // Whatever boot this probe was measuring is over (docs/lifecycle.md): the
    // sub-deadline below must time *this* host incarnation, not a previous one.
    deps.control.recordBootProbe(orb.id, {
      hostState: null,
      hostRunningSinceWall: null,
      hostRunningSinceMono: null,
      answered: false,
    });
    // Definitive absence: idempotent provision restores the host (docs/lifecycle.md).
    const provisioned = await provisionHost(task, deps, orb, project.repositoryUrl, "host_absent");
    if (provisioned.isErr()) {
      if (provisioned.error.retryable) return retryable(provisioned.error);
      // A conflict here is a racing revision, not a broken orb: the winner's
      // compute exists but its commit may not have landed yet, so a failOrb
      // CAS could still succeed and discard the winner's fresh compute.
      // Re-read and reconcile instead; the durable spec/incarnation logic
      // owns any surviving mismatch (docs/compute-replacement.md).
      if (provisioned.error.code === "conflict") return { type: "conflict" };
      return failOrb(task, deps, orb, "provider_failed", provisioned.error.message);
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
        hostSpecFingerprint: provisioned.value.specFingerprint,
        hostSpecGeneration: provisioned.value.specGeneration,
      });
      if (updated.isErr()) {
        return updated.error.type === "state_conflict"
          ? { type: "conflict" }
          : retryable(updated.error);
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
      // The host is down, so any "running since" this probe carries belongs to
      // a boot that is already over; null resets it and the boot sub-deadline
      // times the incarnation the start below creates. Without this reset a
      // reconciler that watched an earlier boot — a draining revision that
      // never made the `running` transition itself, so never cleared its probe
      // — fails the next start as `runtime_never_answered` the moment the old
      // clock runs out (found by `mixed-generation.dst.test.ts`).
      deps.control.recordBootProbe(orb.id, {
        hostState: observation.state,
        hostRunningSinceWall: null,
        hostRunningSinceMono: null,
        answered: false,
      });
      const started = await startHost(
        task,
        deps,
        orb.id,
        hostResourceId,
        orb.hostIncarnation,
        startSpecFingerprint,
        `host_observed_${observation.state}`,
      );
      if (started.isErr()) {
        return started.error.retryable
          ? retryable(started.error)
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
        // Sub-deadline (docs/lifecycle.md): the health server starts before slow
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
          logOrbEvent(task, orb.id, "boot-failed", {
            reason: "runtime_never_answered",
            host: hostResourceId,
            host_running_s: seconds,
            probes: probe.attempts,
            last_error: health.error.message,
            diagnostics: evidence,
          });
          return failOrb(
            task,
            deps,
            orb,
            "runtime_never_answered",
            `host ran for ${seconds}s but the runtime never answered ` +
              `(${probe.attempts} probes; last error: ${health.error.message})` +
              (evidence !== null && evidence !== "" ? `; host diagnostics: ${evidence}` : ""),
            evidence,
          );
        }
        return waiting("readiness");
      }
      const status = health.value;
      // A finished setup still anchors the hold; see `resolveSetupAnchor`.
      const reportedSetup = status.status === "failed" ? undefined : status.hooks?.setup;
      const setupStartedAt =
        reportedSetup !== undefined && reportedSetup.incarnation === String(orb.hostIncarnation)
          ? Date.parse(reportedSetup.startedAt)
          : Number.NaN;
      deps.control.recordBootProbe(orb.id, {
        ...probeBase,
        answered: true,
        setupRunning: status.status === "initializing" && status.phase === "setup_running",
        ...(Number.isFinite(setupStartedAt) ? { setupStartedAtWall: setupStartedAt } : {}),
        nowMono: task.monotonicNow(),
        nowWall: task.wallNow(),
      });
      if (status.status === "initializing") return waiting("readiness");
      if (status.status === "failed") {
        return failOrb(
          task,
          deps,
          orb,
          "runtime_failed",
          `${status.error.code}: ${status.error.message}`,
        );
      }
      if (status.orbId !== orb.id) {
        return failOrb(
          task,
          deps,
          orb,
          "runtime_failed",
          `runtime identity mismatch: expected ${orb.id}, got ${status.orbId}`,
        );
      }
      // Persist ready identity before the orb becomes running (docs/lifecycle.md),
      // together with this boot's boot-hook verdict — written on every ready
      // transition, so a clean boot clears the previous one's failure.
      const hookFailure = firstHookFailure(status.hooks);
      const updated = await deps.store.casUpdateFields(task, {
        orbId: orb.id,
        expectedStateVersion: orb.stateVersion,
        now: task.wallNow(),
        checkoutCommit: status.checkoutCommit,
        hostRef: hostResourceId,
        hookFailureHook: hookFailure?.hook ?? null,
        hookFailureReason: hookFailure?.reason ?? null,
        hookFailureLog: hookFailure?.logPath ?? null,
      });
      if (updated.isErr()) {
        return updated.error.type === "state_conflict"
          ? { type: "conflict" }
          : retryable(updated.error);
      }
      deps.control.clearBootProbe(orb.id);
      const transitioned = await transitionTo(task, deps, updated.value, "running", {
        lastError: null,
        reason: "runtime_ready",
      });
      if (transitioned.type === "transitioned") {
        deps.control.resetLivenessBaseline(orb.id, task.monotonicNow());
        // The runtime's boot resume decision, on the transition that ends the
        // boot episode — one line per boot, never one per health poll
        // (docs/lifecycle.md). Only notable decisions carry the field.
        if (status.turnResume !== undefined) {
          logOrbEvent(task, orb.id, "turn-resume", {
            outcome: status.turnResume.outcome,
            shape: status.turnResume.shape,
            head_record_id: status.turnResume.headRecordId,
          });
        }
        // Boot-hook failures, on the same transition and under the same rule:
        // a hook that succeeded is silent, and a hook that keeps failing every
        // boot of one compute incarnation is one condition, logged when it
        // starts. The incarnation is part of the key because a replacement is
        // new compute running the hook afresh — that outcome is a new edge,
        // not a repeat. Output content never reaches the log.
        for (const hook of ["setup", "resume"] as const) {
          const outcome = status.hooks?.[hook];
          const failed = outcome !== undefined && outcome.outcome !== "ok";
          const key = `${hook}-hook-failed:${orb.id}:${outcome?.incarnation ?? orb.hostIncarnation}`;
          if (deps.control.noteCondition(key, failed) && failed) {
            logOrbEvent(task, orb.id, `${hook}-failed`, {
              incarnation: outcome.incarnation,
              reason: outcome.outcome,
              exit_code: outcome.exitCode,
              log: outcome.logPath,
            });
          }
        }
      }
      return transitioned;
    }
  }
}

// ---------------------------------------------------------------------------
// running

/** Ordinary grace, unless the baseline came from a restart that must boot first. */
function livenessGraceMs(deps: ControlPlaneDeps, liveness: LivenessEntry): number {
  return liveness.restartGraceMs ?? deps.constants.unreachableGraceMs;
}

function squashMessageBatch(
  messages: readonly { content: readonly MessageInputBlock[] }[],
): MessageInputBlock[] {
  const content: MessageInputBlock[] = [];
  for (const [messageIndex, message] of messages.entries()) {
    if (messageIndex > 0) {
      const last = content.at(-1);
      if (last?.type === "text")
        content[content.length - 1] = { ...last, text: `${last.text}\n\n` };
      else content.push({ type: "text", text: "\n\n" });
    }
    for (const block of message.content) {
      const last = content.at(-1);
      if (block.type === "text" && last?.type === "text") {
        content[content.length - 1] = { ...last, text: last.text + block.text };
      } else {
        content.push(block);
      }
    }
  }
  return content;
}

async function reconcileRunning(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orb: OrbRow,
): Promise<ReconcileOutcome> {
  if (orb.hostRef === null) {
    return transitionTo(task, deps, orb, "starting", { reason: "no_host_ref" });
  }
  const observed = await observeHost(task, deps, orb.hostRef);
  if (observed.isErr()) {
    return observed.error.retryable
      ? retryable(observed.error)
      : failOrb(task, deps, orb, "provider_failed", observed.error.message);
  }
  const observation = observed.value;
  const identityFailure = await failOnObservationMismatch(task, deps, orb, observation);
  if (identityFailure !== null) return identityFailure;
  if (observation === null || observation.state === "stopped" || observation.state === "failed") {
    // Unexpected absence/stop: restore the host around the retained
    // filesystem (docs/lifecycle.md).
    return transitionTo(task, deps, orb, "starting", {
      reason: observation === null ? "host_absent" : `host_observed_${observation.state}`,
    });
  }
  if (observation.state === "starting" || observation.state === "stopping") {
    return waiting("host_transition");
  }
  // Host running: derive runtime liveness from the history pull. Liveness is
  // judged on every `running` pass, ahead of any inbox work: a delivery that
  // hangs against a dead runtime must not be able to preempt the restart that
  // revives it (docs/lifecycle.md, 2026-08-10).
  const liveness = deps.control.getLiveness(orb.id);
  if (liveness === null) {
    // Fresh process (control-plane restart): seed the baseline now.
    deps.control.resetLivenessBaseline(orb.id, task.monotonicNow());
    return { type: "noop" };
  }
  const graceMs = livenessGraceMs(deps, liveness);
  const silentMs = task.monotonicNow() - liveness.lastSuccessAt;
  if (silentMs > graceMs) {
    logOrbEvent(task, orb.id, "unreachable-restart", {
      host: orb.hostRef,
      state: "running",
      grace_ms: graceMs,
      grace_kind: liveness.restartGraceMs !== null ? "post_restart" : "ordinary",
      silent_ms: Math.round(silentMs),
    });
    deps.control.markRestartPending(orb.id);
    const stopped = await stopHost(task, deps, orb.id, orb.hostRef, "unreachable_runtime");
    if (stopped.isErr()) {
      return stopped.error.retryable
        ? retryable(stopped.error)
        : failOrb(task, deps, orb, "provider_failed", stopped.error.message);
    }
    const started = await startHost(
      task,
      deps,
      orb.id,
      orb.hostRef,
      orb.hostIncarnation,
      orb.hostSpecFingerprint,
      "unreachable_runtime",
    );
    if (started.isErr()) {
      return started.error.retryable
        ? retryable(started.error)
        : failOrb(task, deps, orb, "provider_failed", started.error.message);
    }
    deps.control.clearRestartPending(orb.id);
    // The restarted host is booting, which no liveness grace can outlast by
    // repetition: re-enter `starting` so the patient readiness path owns the
    // recovery (docs/lifecycle.md, 2026-08-06). The boot-sized baseline covers
    // the case where this CAS loses — a `running` orb must never restart the
    // same booting host twice.
    deps.control.resetLivenessBaseline(
      orb.id,
      task.monotonicNow(),
      deps.constants.postRestartGraceMs,
    );
    return transitionTo(task, deps, orb, "starting", { reason: "unreachable_restart" });
  }

  // Freeze every currently queued item into one durable FIFO batch. The
  // runtime sees one user message with blank-line separators and one stable
  // batch ID; later arrivals form the next batch rather than changing an
  // in-flight retry's payload.
  const pendingBatch = await deps.store.claimNextOrbMessageBatch(task, {
    orbId: orb.id,
    now: task.wallNow(),
  });
  if (pendingBatch.isErr()) return retryable(pendingBatch.error);
  if (pendingBatch.value.length > 0) {
    if (observation.runtimeAddress === undefined) return retryable("runtime address unavailable");
    const messageIds = pendingBatch.value.map((message) => message.messageId);
    const batchId = pendingBatch.value[0]?.deliveryBatchId ?? messageIds[0] ?? "";
    const delivered = await withDeadline(
      task,
      deps.constants.runtimeRequestTimeoutMs,
      "deliver queued message batch",
      (context) =>
        deps.runtimeClient.deliverMessage(
          task,
          {
            baseUrl: observation.runtimeAddress?.baseUrl ?? "",
            messageId: batchId,
            messageIds,
            content: squashMessageBatch(pendingBatch.value),
          },
          context,
        ),
    );
    if (delivered.isErr()) {
      if (delivered.error.retryable) return retryable(delivered.error);
      // A rejection the runtime will repeat for the same payload (an oversized
      // or malformed message) is terminal for this batch: redelivering it
      // forever would wedge every later message behind it. The rows leave the
      // outstanding set carrying the runtime's reason, which the message
      // resource and the UI show as a failed message (docs/runtime-protocol.md).
      const failed = await deps.store.failOrbMessageBatch(task, {
        orbId: orb.id,
        messageIds,
        lastError: delivered.error.message,
        now: task.wallNow(),
      });
      if (failed.isErr()) return retryable(failed.error);
      logOrbEvent(task, orb.id, "message-batch-failed", {
        batch_id: batchId,
        message_count: messageIds.length,
        code: delivered.error.code,
        error: delivered.error.message,
      });
      return { type: "progressed" };
    }
    // The runtime just answered an authenticated request, which is exactly
    // what liveness measures; without this, an orb whose pulls are lagging can
    // be restarted in the same second its runtime served a delivery.
    deps.control.noteRuntimeAnswered(orb.id, task.monotonicNow());
    // The idle anchor is when the user's work reached the runtime, not when it
    // was admitted: a batch can sit in the queue for longer than the whole
    // idle window (a stopped orb, an unreachable runtime), and then the first
    // pass after it leaves the outstanding set would idle-stop an orb whose
    // turn had just begun. Advisory and monotone, like every other
    // `last_busy_at` write (docs/lifecycle.md).
    await deps.store.touchLastBusy(task, { orbId: orb.id, now: task.wallNow() });
    const noted = await deps.store.noteOrbMessageDelivery(task, {
      orbId: orb.id,
      messageIds,
      delivery: delivered.value.delivery,
      operationId: delivered.value.operationId,
      now: task.wallNow(),
    });
    if (noted.isErr()) return retryable(noted.error);
    if (!delivered.value.duplicate) {
      logOrbEvent(task, orb.id, "message-batch-dispatched", {
        batch_id: batchId,
        message_count: messageIds.length,
        delivery: delivered.value.delivery,
      });
    }
    // An undelivered message is user work in flight, so the idle countdown
    // below is deliberately not reached while a batch is outstanding.
    return { type: "noop" };
  }

  // Idle auto-stop (docs/lifecycle.md). Only a tab that affirmatively reports
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
    const transitioned = await transitionTo(task, deps, orb, "stopping", {
      stopReason: "idle",
      reason: `idle_for_${Math.round((now - lastActivityAt) / 1000)}s`,
    });
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
  // New live connections are rejected and existing agent/terminal proxies are
  // closed while stopping (docs/lifecycle.md).
  deps.control.markStopping(orb.id);
  deps.control.closeBrowserConnections(orb.id);

  if (orb.hostRef === null) {
    // Nothing was ever provisioned; nothing to drain or stop.
    return transitionTo(task, deps, orb, "stopped", { reason: "no_host_ref" });
  }
  const observed = await observeHost(task, deps, orb.hostRef);
  if (observed.isErr()) {
    return observed.error.retryable
      ? retryable(observed.error)
      : failOrb(task, deps, orb, "provider_failed", observed.error.message);
  }
  const observation = observed.value;
  const identityFailure = await failOnObservationMismatch(task, deps, orb, observation);
  if (identityFailure !== null) return identityFailure;
  if (observation === null || observation.state === "stopped" || observation.state === "failed") {
    // A host we stopped ourselves as half of an unreachable-runtime restart
    // is not "already stopped": complete the restart so the drain can finish.
    if (observation !== null && deps.control.isRestartPending(orb.id)) {
      const started = await startHost(
        task,
        deps,
        orb.id,
        orb.hostRef,
        orb.hostIncarnation,
        orb.hostSpecFingerprint,
        "complete_pending_restart",
      );
      if (started.isErr()) {
        return started.error.retryable
          ? retryable(started.error)
          : failOrb(task, deps, orb, "provider_failed", started.error.message);
      }
      deps.control.clearRestartPending(orb.id);
      deps.control.resetLivenessBaseline(
        orb.id,
        task.monotonicNow(),
        deps.constants.postRestartGraceMs,
      );
      return { type: "progressed" };
    }
    // Absent or already-stopped host: no runtime to drain; complete records
    // left on the persistent filesystem are found on the next start (docs/lifecycle.md).
    if (observation !== null && observation.state === "failed") {
      await stopHost(task, deps, orb.id, orb.hostRef, "host_observed_failed");
    }
    return transitionTo(task, deps, orb, "stopped", {
      reason: observation === null ? "host_absent" : `host_observed_${observation.state}`,
    });
  }
  if (observation.state === "starting" || observation.state === "stopping") {
    return waiting("host_transition");
  }

  // Host is running.
  if (hasNeverBeenReady(orb)) {
    // Never reached ready and has no session: no user request could have been
    // accepted, so the drain is skipped (docs/lifecycle.md).
    logOrbEvent(task, orb.id, "drain-skipped", { reason: "never_ready" });
    const stopped = await stopHost(task, deps, orb.id, orb.hostRef, "drain_skipped");
    if (stopped.isErr()) {
      return stopped.error.retryable
        ? retryable(stopped.error)
        : failOrb(task, deps, orb, "provider_failed", stopped.error.message);
    }
    return transitionTo(task, deps, orb, "stopped", { reason: "drain_skipped" });
  }

  // A drain stuck longer than the create/start deadline cannot be completed
  // by waiting: the runtime cannot be restored to ready (docs/lifecycle.md).
  if (task.wallNow() - orb.stateChangedAt > deps.constants.createStartDeadlineMs) {
    return failOrb(
      task,
      deps,
      orb,
      "drain_runtime_unrecoverable",
      "history drain could not complete within the create/start deadline",
    );
  }

  // The unreachable-runtime restart applies during stopping too, so a pending
  // drain is never stranded behind a dead runtime process (docs/lifecycle.md).
  // The drain must stay in `stopping`, so unlike `running` this cannot hand
  // recovery to the readiness path: instead the restart gets a boot-sized
  // grace and is attempted exactly once per stopping episode.
  const liveness = deps.control.getLiveness(orb.id);
  if (liveness === null) {
    deps.control.resetLivenessBaseline(orb.id, task.monotonicNow());
  } else if (task.monotonicNow() - liveness.lastSuccessAt > livenessGraceMs(deps, liveness)) {
    const silentMs = Math.round(task.monotonicNow() - liveness.lastSuccessAt);
    if (liveness.restartGraceMs !== null) {
      // The restarted host had a full boot's worth of grace and still never
      // answered a pull; a second restart would only repeat the evidence.
      logOrbEvent(task, orb.id, "drain-restart-cap", {
        host: orb.hostRef,
        grace_ms: liveness.restartGraceMs,
        silent_ms: silentMs,
        decision: "fail_drain",
      });
      return failOrb(
        task,
        deps,
        orb,
        "drain_runtime_unrecoverable",
        `the runtime did not answer within ${liveness.restartGraceMs}ms of a host restart`,
      );
    }
    logOrbEvent(task, orb.id, "unreachable-restart", {
      host: orb.hostRef,
      state: "stopping",
      grace_ms: deps.constants.unreachableGraceMs,
      grace_kind: "ordinary",
      silent_ms: silentMs,
    });
    deps.control.markRestartPending(orb.id);
    const stopped = await stopHost(task, deps, orb.id, orb.hostRef, "unreachable_runtime");
    if (stopped.isErr()) return retryable(stopped.error);
    const started = await startHost(
      task,
      deps,
      orb.id,
      orb.hostRef,
      orb.hostIncarnation,
      orb.hostSpecFingerprint,
      "unreachable_runtime",
    );
    if (started.isErr()) {
      return started.error.retryable
        ? retryable(started.error)
        : failOrb(task, deps, orb, "provider_failed", started.error.message);
    }
    deps.control.clearRestartPending(orb.id);
    deps.control.resetLivenessBaseline(
      orb.id,
      task.monotonicNow(),
      deps.constants.postRestartGraceMs,
    );
    return { type: "progressed" };
  }

  // The controlled-shutdown pull barrier (docs/history-replication.md).
  const outcome = await pollOrbUntilCaughtUp(task, deps, orb.id);
  switch (outcome.type) {
    case "caught_up": {
      logOrbEvent(task, orb.id, "drain-caught-up", {
        records: outcome.committedRecords,
        after_retrying: deps.control.getDrainStatus(orb.id)?.retrying === true ? true : undefined,
      });
      deps.control.setDrainStatus(orb.id, { retrying: false });
      const stopped = await stopHost(task, deps, orb.id, orb.hostRef, "drain_complete");
      if (stopped.isErr()) {
        return stopped.error.retryable
          ? retryable(stopped.error)
          : failOrb(task, deps, orb, "provider_failed", stopped.error.message);
      }
      return transitionTo(task, deps, orb, "stopped", { reason: "drain_complete" });
    }
    case "retryable":
      // The stop must not proceed; the host stays running while we retry. A
      // blocked drain re-enters this branch every reconcile tick, so only the
      // edge into "retrying" is logged (docs/lifecycle.md noise rule).
      if (deps.control.getDrainStatus(orb.id)?.retrying !== true) {
        logOrbEvent(task, orb.id, "drain-blocked", { message: outcome.message });
      }
      deps.control.setDrainStatus(orb.id, { retrying: true, message: outcome.message });
      return waiting("drain_blocked");
    case "integrity":
      // The poll atomically failed the orb and requested shared compute disposal.
      logOrbEvent(task, orb.id, "drain-integrity", { reason: outcome.reason });
      return { type: "transitioned", toState: "failed" };
    case "orb_gone":
      return { type: "conflict" };
  }
}

// ---------------------------------------------------------------------------
// shared irreversible resource disposal (delete + archive)

async function reconcileResourceDisposal(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orb: OrbRow,
): Promise<ReconcileOutcome | null> {
  const cleaned = await withDeadline(
    task,
    deps.constants.providerOperationTimeoutMs,
    "clean orb external resources",
    (context) => deps.resourceCleaner.cleanupOrb(task, orb.id, context),
  );
  if (cleaned.isErr()) {
    await deps.store.recordOrbDeletionError(task, {
      orbId: orb.id,
      message: `resource cleanup: ${cleaned.error.message}`,
      now: task.wallNow(),
    });
    return retryable(cleaned.error);
  }

  const destroyed = await destroyHost(task, deps, orb.id);
  if (destroyed.isErr()) {
    await deps.store.recordOrbDeletionError(task, {
      orbId: orb.id,
      message: `resource cleanup: ${destroyed.error.message}`,
      now: task.wallNow(),
    });
    return retryable(destroyed.error);
  }

  const intent = await deps.store.getOrbDeletion(task, orb.id);
  if (intent.isErr()) return retryable(intent.error);
  if (intent.value === null) return retryable(`${orb.state} orb has no cleanup intent`);
  if (intent.value.lastError !== null || orb.lastError !== null) {
    const cleared = await deps.store.recordOrbDeletionError(task, {
      orbId: orb.id,
      message: null,
      now: task.wallNow(),
    });
    if (cleared.isErr()) return retryable(cleared.error);
  }
  if (task.wallNow() < intent.value.cleanupAfter) return waiting("deletion_quarantine");
  return null;
}

async function reconcileDeleting(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orb: OrbRow,
): Promise<ReconcileOutcome> {
  deps.control.markStopping(orb.id);
  deps.control.closeBrowserConnections(orb.id);
  const intent = await deps.store.getOrbDeletion(task, orb.id);
  if (intent.isErr()) return retryable(intent.error);
  if (intent.value === null || intent.value.kind !== "delete") {
    return retryable("deleting orb has no deletion cleanup intent");
  }
  const disposal = await reconcileResourceDisposal(task, deps, orb);
  if (disposal !== null) return disposal;
  const finalized = await deps.store.finalizeOrbDeletion(task, {
    orbId: orb.id,
    expectedStateVersion: orb.stateVersion,
  });
  if (finalized.isErr()) {
    return finalized.error.type === "state_conflict"
      ? { type: "conflict" }
      : retryable(finalized.error);
  }
  deps.control.clearOrb(orb.id);
  logOrbEvent(task, orb.id, "deleted", { outcome: "all_resources_removed" });
  return { type: "progressed" };
}

async function reconcileArchiving(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orb: OrbRow,
): Promise<ReconcileOutcome> {
  deps.control.markStopping(orb.id);
  deps.control.closeBrowserConnections(orb.id);
  const intent = await deps.store.getOrbDeletion(task, orb.id);
  if (intent.isErr()) return retryable(intent.error);
  if (intent.value === null || intent.value.kind !== "archive") {
    return retryable("archiving orb has no archive cleanup intent");
  }

  if (intent.value.historySealedAt === null) {
    if (!hasNeverBeenReady(orb)) {
      if (orb.hostRef === null) {
        // Failed-compute disposal intentionally clears the old host ref. An
        // archive still needs a readable authoritative runtime to pull and
        // seal the retained workspace, so provision the already-advanced clean
        // incarnation before continuing the ordinary archive barrier.
        const projectResult = await deps.store.getProject(task, orb.projectId);
        if (projectResult.isErr()) return retryable(projectResult.error);
        if (projectResult.value === null) {
          const message = `archive cannot restore runtime: project ${orb.projectId} is absent`;
          await deps.store.recordOrbDeletionError(task, {
            orbId: orb.id,
            message,
            now: task.wallNow(),
          });
          return retryable(message);
        }
        await task.checkpoint("compute-replacement.replacement-before-provision");
        const provisioned = await provisionHost(
          task,
          deps,
          orb,
          projectResult.value.repositoryUrl,
          "archive_history_seal",
        );
        if (provisioned.isErr()) {
          // A racing revision's compute answers this provision with a
          // conflict; re-read rather than recording a permanent-looking error.
          if (provisioned.error.code === "conflict") return { type: "conflict" };
          const message = boundedDiscardText(provisioned.error.message);
          await deps.store.recordOrbDeletionError(task, {
            orbId: orb.id,
            message,
            now: task.wallNow(),
          });
          return retryable(provisioned.error);
        }
        await task.checkpoint("compute-replacement.replacement-after-provision");
        await task.checkpoint("compute-replacement.replacement-before-commit");
        const committed = await deps.store.casUpdateFields(task, {
          orbId: orb.id,
          expectedStateVersion: orb.stateVersion,
          now: task.wallNow(),
          hostRef: provisioned.value.ref.resourceId,
          runtimeTokenHash: provisioned.value.runtimeTokenHash,
          hostSpecFingerprint: provisioned.value.specFingerprint,
          hostSpecGeneration: provisioned.value.specGeneration,
          hostDiscardEvidence: null,
        });
        if (committed.isErr()) {
          return committed.error.type === "state_conflict"
            ? { type: "conflict" }
            : retryable(committed.error);
        }
        await task.checkpoint("compute-replacement.replacement-committed");
        await deps.store.recordOrbDeletionError(task, {
          orbId: orb.id,
          message: null,
          now: task.wallNow(),
        });
        logOrbEvent(task, orb.id, "replacement-provisioned", {
          host: provisioned.value.ref.resourceId,
          incarnation: provisioned.value.incarnation,
          reason: "archive_history_seal",
        });
        return { type: "progressed" };
      }
      const observed = await observeHost(task, deps, orb.hostRef);
      if (observed.isErr()) return retryable(observed.error);
      const mismatch = await failOnObservationMismatch(task, deps, orb, observed.value);
      if (mismatch !== null) return mismatch;
      if (observed.value === null) {
        const message = "archive cannot restore the authoritative runtime: host is absent";
        await deps.store.recordOrbDeletionError(task, {
          orbId: orb.id,
          message,
          now: task.wallNow(),
        });
        return retryable(message);
      }
      if (observed.value.state === "stopped" || observed.value.state === "failed") {
        const started = await startHost(
          task,
          deps,
          orb.id,
          orb.hostRef,
          orb.hostIncarnation,
          orb.hostSpecFingerprint,
          "archive_history_seal",
        );
        if (started.isErr()) {
          if (started.error.retryable) return retryable(started.error);
          // A permanent conflict means this compute can never seal history
          // (its stamp contradicts the durable row). Dispose it through the
          // ordinary replacement intent; the next archiving pass provisions
          // the clean incarnation that seals the retained workspace.
          const projectResult = await deps.store.getProject(task, orb.projectId);
          if (projectResult.isErr()) return retryable(projectResult.error);
          if (projectResult.value === null) {
            return retryable(`archive cannot replace compute: project ${orb.projectId} is absent`);
          }
          const replacement = await deps.store.requestHostSpecReplacement(task, {
            orbId: orb.id,
            expectedStateVersion: orb.stateVersion,
            desiredFingerprint: deps.hostProvider.desiredSpecFingerprint({
              orbId: orb.id,
              repositoryUrl: projectResult.value.repositoryUrl,
            }),
            configuredGeneration: deps.hostProvider.specGeneration,
            force: true,
            now: task.wallNow(),
          });
          if (replacement.isErr()) {
            return replacement.error.type === "state_conflict"
              ? { type: "conflict" }
              : retryable(replacement.error);
          }
          if (replacement.value.type === "requested") {
            logOrbEvent(task, orb.id, "compute-discard-requested", {
              host: orb.hostRef,
              through_incarnation: orb.hostIncarnation,
              reason: "host_spec_changed",
            });
            return waiting("stale_compute_disposal");
          }
          // Declined: a newer generation owns this compute; leave it alone and
          // let the surviving revision converge the archive.
          return retryable(started.error);
        }
        return { type: "progressed" };
      }
      if (observed.value.state !== "running" || observed.value.runtimeAddress === undefined) {
        return waiting("readiness");
      }
      const pulled = await pollOrbUntilCaughtUp(task, deps, orb.id);
      if (pulled.type === "retryable") return retryable(pulled);
      if (pulled.type === "integrity") {
        const message = `archive blocked by replication integrity: ${pulled.reason}`;
        await deps.store.recordOrbDeletionError(task, {
          orbId: orb.id,
          message,
          now: task.wallNow(),
        });
        return retryable(message);
      }
      if (pulled.type === "orb_gone") return { type: "conflict" };
      if (deps.control.getLiveness(orb.id)?.activity === "busy") {
        return waiting("drain_blocked");
      }
    }
    const current = await deps.store.getOrb(task, orb.id);
    if (current.isErr()) return retryable(current.error);
    if (current.value === null || current.value.state !== "archiving") return { type: "conflict" };
    const sealed = await deps.store.sealOrbArchive(task, {
      orbId: orb.id,
      expectedStateVersion: current.value.stateVersion,
      now: task.wallNow(),
      cursor: current.value.replicationCursor,
      headId: current.value.replicatedHeadId,
    });
    if (sealed.isErr())
      return sealed.error.type === "state_conflict"
        ? { type: "conflict" }
        : retryable(sealed.error);
    logOrbEvent(task, orb.id, "archive-history-sealed", {
      cursor: current.value.replicationCursor,
      head: current.value.replicatedHeadId,
    });
    return { type: "progressed" };
  }

  const disposal = await reconcileResourceDisposal(task, deps, orb);
  if (disposal !== null) return disposal;
  const finalized = await deps.store.finalizeOrbArchive(task, {
    orbId: orb.id,
    expectedStateVersion: orb.stateVersion,
    now: task.wallNow(),
  });
  if (finalized.isErr())
    return finalized.error.type === "state_conflict"
      ? { type: "conflict" }
      : retryable(finalized.error);
  deps.control.clearOrb(orb.id);
  logOrbEvent(task, orb.id, "archived", { outcome: "transcript_retained_resources_removed" });
  return { type: "transitioned", toState: "archived" };
}

// ---------------------------------------------------------------------------
// stopped / failed backstop

async function reconcileTerminalBackstop(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orb: OrbRow,
): Promise<ReconcileOutcome> {
  // This is the *only* message-driven lifecycle transition: admission records
  // the message and its wake intent, and the transition happens here, for
  // every caller, with its own edge log (docs/lifecycle.md, 2026-08-11).
  //
  // Any outstanding message's wake intent starts a `stopped` orb, not only the
  // oldest one's: FIFO decides delivery order, never whether the orb comes up.
  // The decision and the transition are one store transaction, so an explicit
  // stop that clears the intent can never be raced by a stale read; the intent
  // itself is left standing until the message is delivered, failed, or
  // explicitly stopped, which is what makes the wake retryable without a
  // second write to strand.
  //
  // A `failed` orb wakes only for an intent admitted against its current
  // `state_version`, i.e. a send the user made after seeing this failure. The
  // transition bumps that version, so the retry is one-shot: a boot that fails
  // again is never retried by the same intent, and "terminal boot failure is
  // not retried forever" survives while a new send still starts a failed orb.
  const woken = await deps.store.casStartOrbForQueuedMessage(task, {
    orbId: orb.id,
    expectedStateVersion: orb.stateVersion,
    now: task.wallNow(),
  });
  if (woken.isErr()) {
    return woken.error.type === "state_conflict" ? { type: "conflict" } : retryable(woken.error);
  }
  if (woken.value !== null) {
    logOrbEvent(task, orb.id, "transition", {
      from: orb.state,
      to: "starting",
      reason: "queued_message",
    });
    return { type: "transitioned", toState: "starting" };
  }
  if (orb.hostRef === null) return { type: "noop" };
  const observed = await observeHost(task, deps, orb.hostRef);
  if (observed.isErr()) return retryable(observed.error);
  const observation = observed.value;
  const identityFailure = await failOnObservationMismatch(task, deps, orb, observation);
  if (identityFailure !== null) return identityFailure;
  if (observation === null || observation.state === "stopped") return { type: "noop" };
  if (observation.state === "stopping") return waiting("host_transition");
  const stopped = await stopHost(task, deps, orb.id, orb.hostRef, `terminal_backstop:${orb.state}`);
  if (stopped.isErr()) return retryable(stopped.error);
  return { type: "progressed" };
}

// ---------------------------------------------------------------------------

export async function reconcileOrbOnce(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orbId: string,
): Promise<ReconcileOutcome> {
  const orbResult = await deps.store.getOrb(task, orbId);
  if (orbResult.isErr()) return retryable(orbResult.error);
  const orb = orbResult.value;
  if (orb === null) return { type: "noop" };
  // Everything this process remembers is scoped to the orb's current visit to
  // its state (docs/lifecycle.md): a reconciler that never made the transition
  // itself must not judge this episode by the previous one's clocks.
  deps.control.noteStateEpisode(orb.id, orb.stateChangedAt);
  if (
    orb.hostDiscardThroughIncarnation !== null &&
    orb.state !== "deleting" &&
    orb.state !== "archived"
  ) {
    return reconcileHostDiscard(task, deps, orb);
  }
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
    case "archived":
      return { type: "noop" };
    case "archiving":
      return reconcileArchiving(task, deps, orb);
    case "deleting":
      return reconcileDeleting(task, deps, orb);
  }
}

// ---------------------------------------------------------------------------
// Commands (docs/lifecycle.md)

export interface CommandError {
  readonly type: "command_error";
  /**
   * `internal` is a deterministic store bug (`StoreError` code `invariant`):
   * the caller must not retry it, so it answers 500 with `retryable: false`
   * rather than a 503 that invites a retry loop
   * (docs/postmortems/2026-08-11-orb-message-jsonb-param-encoding.md).
   */
  readonly code: "not_found" | "conflict" | "unavailable" | "internal";
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

/** A store failure as a command failure: `invariant` is internal, never retryable. */
function mapStoreError(error: StoreError): CommandError {
  return error.code === "invariant"
    ? commandError("internal", error.message, false)
    : commandError("unavailable", error.message, error.retryable);
}

function mapCasError(error: StoreError | StateConflict): CommandError {
  return error.type === "state_conflict"
    ? commandError("conflict", "concurrent state change", true)
    : mapStoreError(error);
}

/** Create inserts `creating` (docs/control-plane-api.md: creation also requests start). */
export function createOrb(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  params: { orbId: string; projectId: string; name?: string },
): ResultAsync<OrbRow, CommandError> {
  const run = async (): Promise<Result<OrbRow, CommandError>> => {
    const projectResult = await deps.store.getProject(task, params.projectId);
    if (projectResult.isErr()) {
      return err(mapStoreError(projectResult.error));
    }
    if (projectResult.value === null) {
      return err(commandError("not_found", `project ${params.projectId} not found`, false));
    }
    if (projectResult.value.state === "deleting") {
      return err(commandError("conflict", "project is being permanently deleted", false));
    }
    const existing = await deps.store.getOrb(task, params.orbId);
    if (existing.isErr()) return err(mapStoreError(existing.error));
    if (existing.value !== null) {
      if (existing.value.state === "deleting") {
        return err(commandError("conflict", "orb is being permanently deleted", false));
      }
      if (
        existing.value.projectId !== params.projectId ||
        (params.name !== undefined && existing.value.name !== params.name)
      ) {
        return err(commandError("conflict", "orb id exists with different content", false));
      }
      return ok(existing.value);
    }
    const now = task.wallNow();
    const row: OrbRow = {
      id: params.orbId,
      projectId: params.projectId,
      name: params.name ?? null,
      autoNameLeaseUntil: null,
      autoNameAttempts: 0,
      autoNameNextAttemptAt: null,
      state: "creating",
      stateVersion: 0,
      hostKind: deps.hostProvider.kind,
      hostRef: null,
      hostIncarnation: 0,
      hostSpecFingerprint: null,
      hostSpecGeneration: null,
      hostDiscardThroughIncarnation: null,
      hostDiscardReason: null,
      hostDiscardError: null,
      hostDiscardEvidence: null,
      hostDiscardRequestedAt: null,
      hookFailureHook: null,
      hookFailureReason: null,
      hookFailureLog: null,
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
    if (inserted.isErr()) {
      if (inserted.error.type === "project_conflict") {
        return inserted.error.reason === "not_found"
          ? err(commandError("not_found", `project ${params.projectId} not found`, false))
          : err(commandError("conflict", "project is being permanently deleted", false));
      }
      return err(mapStoreError(inserted.error));
    }
    logOrbEvent(task, params.orbId, "created", { project: params.projectId });
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
      if (orbResult.isErr()) return err(mapStoreError(orbResult.error));
      const orb = orbResult.value;
      if (orb === null) return err(commandError("not_found", `orb ${orbId} not found`, false));
      switch (orb.state) {
        case "creating":
        case "starting":
        case "running":
          return ok(orb);
        case "stopping":
          return err(commandError("conflict", "orb is stopping; retry after it has stopped", true));
        case "deleting":
          return err(commandError("conflict", "orb is being permanently deleted", false));
        case "archiving":
        case "archived":
          return err(commandError("conflict", "archived orbs cannot be started", false));
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
          if (cas.isOk()) {
            logOrbEvent(task, orbId, "transition", {
              from: orb.state,
              to: "starting",
              reason: "start_requested",
            });
            return ok(cas.value);
          }
          if (cas.error.type === "state_conflict") continue;
          return err(mapCasError(cas.error));
        }
      }
    }
    return err(commandError("conflict", "concurrent state changes; retry", true));
  };
  return new ResultAsync(run());
}

/** Irreversibly retain a read-only transcript while deleting runtime resources. */
export function requestOrbArchive(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orbId: string,
): ResultAsync<OrbRow, CommandError> {
  const run = async (): Promise<Result<OrbRow, CommandError>> => {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const orbResult = await deps.store.getOrb(task, orbId);
      if (orbResult.isErr()) return err(mapStoreError(orbResult.error));
      const orb = orbResult.value;
      if (orb === null) return err(commandError("not_found", `orb ${orbId} not found`, false));
      if (orb.state === "archiving" || orb.state === "archived") return ok(orb);
      if (orb.state === "deleting") {
        return err(commandError("conflict", "orb is being permanently deleted", false));
      }
      const now = task.wallNow();
      const requested = await deps.store.requestOrbArchive(task, {
        orbId,
        expectedStateVersion: orb.stateVersion,
        now,
        cleanupAfter: now + deps.constants.deletionQuarantineMs,
      });
      if (requested.isOk()) {
        deps.control.markStopping(orbId);
        deps.control.closeBrowserConnections(orbId);
        logOrbEvent(task, orbId, "transition", {
          from: orb.state,
          to: "archiving",
          reason: "archive_requested",
        });
        return ok(requested.value);
      }
      if (requested.error.type === "state_conflict") continue;
      return err(mapCasError(requested.error));
    }
    return err(commandError("conflict", "concurrent state changes; retry", true));
  };
  return new ResultAsync(run());
}

export function requestOrbDeletion(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orbId: string,
): ResultAsync<OrbRow, CommandError> {
  const run = async (): Promise<Result<OrbRow, CommandError>> => {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const orbResult = await deps.store.getOrb(task, orbId);
      if (orbResult.isErr()) return err(mapStoreError(orbResult.error));
      const orb = orbResult.value;
      if (orb === null) return err(commandError("not_found", `orb ${orbId} not found`, false));
      if (orb.state === "deleting") return ok(orb);
      const now = task.wallNow();
      const requested = await deps.store.requestOrbDeletion(task, {
        orbId,
        expectedStateVersion: orb.stateVersion,
        now,
        cleanupAfter: now + deps.constants.deletionQuarantineMs,
      });
      if (requested.isOk()) {
        deps.control.markStopping(orbId);
        deps.control.closeBrowserConnections(orbId);
        logOrbEvent(task, orbId, "transition", {
          from: orb.state,
          to: "deleting",
          reason: "delete_requested",
        });
        return ok(requested.value);
      }
      if (requested.error.type === "state_conflict") continue;
      return err(mapCasError(requested.error));
    }
    return err(commandError("conflict", "concurrent state changes; retry", true));
  };
  return new ResultAsync(run());
}

/**
 * An explicit stop outranks every message wake intent recorded before it
 * (docs/lifecycle.md), so the clear runs on every path — including the
 * already-stopping/stopped one, where there is no transition to carry it.
 */
export function requestOrbStop(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orbId: string,
): ResultAsync<OrbRow, CommandError> {
  const run = async (): Promise<Result<OrbRow, CommandError>> => {
    let lastClearError: StoreError | null = null;
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const orbResult = await deps.store.getOrb(task, orbId);
      if (orbResult.isErr()) return err(mapStoreError(orbResult.error));
      const orb = orbResult.value;
      if (orb === null) return err(commandError("not_found", `orb ${orbId} not found`, false));
      if (orb.state === "stopping" || orb.state === "stopped") {
        // A stop with nothing left to transition is a no-op the UI issues
        // freely; its answer must not depend on a bookkeeping write, so the
        // clear is retried and then reported as an edge rather than turned
        // into a 503 the user cannot act on.
        const cleared = await deps.store.clearOrbMessageAutoStart(task, {
          orbId,
          now: task.wallNow(),
        });
        if (cleared.isOk()) return ok(orb);
        lastClearError = cleared.error;
        if (cleared.error.retryable && attempt < CAS_ATTEMPTS - 1) continue;
        logOrbEvent(task, orbId, "stop-wake-clear-failed", {
          state: orb.state,
          error: cleared.error.message,
          outcome: "stop_reported_ok",
        });
        return ok(orb);
      }
      if (orb.state === "deleting") {
        return err(commandError("conflict", "orb is being permanently deleted", false));
      }
      if (orb.state === "archiving" || orb.state === "archived") {
        return err(commandError("conflict", "archived orbs cannot be stopped or restarted", false));
      }
      // Clear before the transition: a stop that cannot cancel the wake
      // intents recorded before it never happens at all, so the orb can never
      // land in `stopped` with an intent that outlived the stop.
      const clearedForStop = await deps.store.clearOrbMessageAutoStart(task, {
        orbId,
        now: task.wallNow(),
      });
      if (clearedForStop.isErr()) {
        lastClearError = clearedForStop.error;
        if (clearedForStop.error.retryable && attempt < CAS_ATTEMPTS - 1) continue;
        return err(mapStoreError(clearedForStop.error));
      }
      const cas = await deps.store.casTransition(task, {
        orbId,
        expectedStateVersion: orb.stateVersion,
        toState: "stopping",
        now: task.wallNow(),
        // An explicit stop presents no reason, including over a stale one.
        stopReason: null,
      });
      if (cas.isOk()) {
        logOrbEvent(task, orbId, "transition", {
          from: orb.state,
          to: "stopping",
          reason: "stop_requested",
        });
        deps.control.markStopping(orbId);
        deps.control.closeBrowserConnections(orbId);
        return ok(cas.value);
      }
      if (cas.error.type === "state_conflict") continue;
      return err(mapCasError(cas.error));
    }
    return err(
      lastClearError === null
        ? commandError("conflict", "concurrent state changes; retry", true)
        : mapStoreError(lastClearError),
    );
  };
  return new ResultAsync(run());
}

/**
 * Durable send-anytime admission (docs/runtime-protocol.md), for every caller.
 * The command records the message and — when the orb cannot take delivery now
 * — its wake intent, then nudges the per-orb reconciler, which owns the single
 * message-driven lifecycle transition and its `transition` edge log. Admission
 * itself never changes orb state (docs/lifecycle.md, 2026-08-11).
 */
export function enqueueOrbMessage(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  params: { orbId: string; messageId: string; content: readonly MessageInputBlock[] },
): ResultAsync<{ message: OrbMessageRow; duplicate: boolean }, CommandError> {
  const run = async (): Promise<
    Result<{ message: OrbMessageRow; duplicate: boolean }, CommandError>
  > => {
    const orbResult = await deps.store.getOrb(task, params.orbId);
    if (orbResult.isErr()) return err(mapStoreError(orbResult.error));
    const orb = orbResult.value;
    if (orb === null) return err(commandError("not_found", `orb ${params.orbId} not found`, false));
    if (orb.state === "deleting") {
      return err(commandError("conflict", "orb is being permanently deleted", false));
    }
    if (orb.state === "archiving" || orb.state === "archived") {
      return err(commandError("conflict", "archived orbs cannot accept messages", false));
    }
    const enqueued = await deps.store.enqueueOrbMessage(task, {
      orbId: params.orbId,
      messageId: params.messageId,
      content: params.content,
      now: task.wallNow(),
    });
    if (enqueued.isErr()) {
      return enqueued.error.type === "store_error"
        ? err(mapStoreError(enqueued.error))
        : err(commandError("conflict", "message id exists with different content", false));
    }
    // Wake latency is the reconciler tick, not the terminal backstop interval:
    // the orb is due now, so a stopped orb starts on the next scan.
    deps.control.setNextAttemptAt(`reconcile:${params.orbId}`, 0);
    if (!enqueued.value.duplicate) {
      logOrbEvent(task, params.orbId, "message-queued", {
        message_id: params.messageId,
        orb_state: enqueued.value.orb.state,
        ...(enqueued.value.message.autoStart ? { wake: "requested" } : {}),
      });
    }
    return ok({ message: enqueued.value.message, duplicate: enqueued.value.duplicate });
  };
  return new ResultAsync(run());
}

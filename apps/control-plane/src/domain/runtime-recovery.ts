import type { RuntimeHealth } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, type Result } from "neverthrow";
import { withDeadline } from "./dst.ts";
import { formatOrbFailure, type StoreError } from "./errors.ts";
import { logOrbEvent } from "./log.ts";
import type { OrbRow } from "./orb.ts";
import type { ControlPlaneDeps } from "./ports.ts";

/** Only the typed ownership guard can authorize an automatic replacement. */
export async function handleFailedRuntime(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orb: OrbRow,
  health: RuntimeHealth,
): Promise<Result<boolean, StoreError>> {
  if (
    health.status !== "failed" ||
    health.orbId !== orb.id ||
    !["running", "starting"].includes(orb.state) ||
    orb.sleepId !== null ||
    orb.hostDiscardThroughIncarnation !== null ||
    deps.hostProvider.specGeneration < (orb.hostSpecGeneration ?? 0)
  )
    return ok(false);
  const episode =
    health.error.code === "claude_child_recovery_required" && orb.harness === "claude"
      ? health.recovery?.episode
      : undefined;
  const recoverable =
    deps.hostProvider.verifiesWholeComputeDisposal === true &&
    episode !== undefined &&
    /^[a-f0-9]{64}$/.test(episode);
  const exhausted = recoverable && orb.claudeRecovery?.claimedEpisodes.includes(episode) === true;
  const replacementFailed =
    orb.claudeRecovery?.verified &&
    orb.claudeRecovery.replacementIncarnation === orb.hostIncarnation;
  await task.checkpoint("claude-recovery.before-claim");
  const claimed = await deps.store.failOrbAndRequestComputeDiscard(task, {
    orbId: orb.id,
    expectedStateVersion: orb.stateVersion,
    now: task.wallNow(),
    lastError: formatOrbFailure(
      "runtime_failed",
      exhausted
        ? "claude_child_recovery_required: automatic compute recovery exhausted"
        : `${health.error.code}: ${health.error.message}`,
    ),
    ...(recoverable && !exhausted ? { recoveryEpisode: episode } : {}),
  });
  if (claimed.isErr())
    return claimed.error.type === "state_conflict" ? ok(false) : err(claimed.error);
  await task.checkpoint("claude-recovery.claimed");
  logOrbEvent(
    task,
    orb.id,
    recoverable
      ? exhausted
        ? "claude-recovery-exhausted"
        : "claude-recovery-claimed"
      : replacementFailed
        ? "claude-recovery-exhausted"
        : "runtime-failed",
    {
      reason: health.error.code,
      ...(recoverable
        ? { episode }
        : replacementFailed
          ? { episode: orb.claudeRecovery?.episode }
          : {}),
      incarnation: orb.hostIncarnation,
    },
  );
  deps.control.clearOrb(orb.id);
  return ok(true);
}

export async function inspectFailedRuntime(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orb: OrbRow,
  baseUrl: string,
): Promise<Result<boolean, StoreError>> {
  const health = await withDeadline(
    task,
    deps.constants.runtimeRequestTimeoutMs,
    "failed runtime health",
    (context) => deps.runtimeClient.health(task, baseUrl, context),
  );
  if (health.isErr()) return ok(false);
  deps.control.noteRuntimeAnswered(orb.id, task.monotonicNow());
  return handleFailedRuntime(task, deps, orb, health.value);
}

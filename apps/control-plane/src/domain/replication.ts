import type { PullHistoryResponse } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { sleepResult, withDeadline } from "./dst.ts";
import { formatOrbFailure, type ReplicationIntegrityError } from "./errors.ts";
import type { ControlPlaneDeps, OrbHostRef } from "./ports.ts";

/**
 * The classified result of pulling one orb until it is caught up
 * (DESIGN.md §8.2/§8.4). Failures are values, not exceptions; integrity
 * failures have already been acted on (host stopped, orb failed) when this
 * returns.
 */
export type PollOutcome =
  | { readonly type: "caught_up"; readonly committedRecords: number }
  | { readonly type: "retryable"; readonly message: string }
  | { readonly type: "integrity"; readonly reason: ReplicationIntegrityError["reason"] }
  | { readonly type: "orb_gone" };

function validatePullResponse(
  orbId: string,
  after: string | null,
  response: PullHistoryResponse,
): ReplicationIntegrityError | null {
  if (response.orbId !== orbId) {
    return {
      type: "replication_integrity",
      reason: "orb_mismatch",
      message: `pull for orb ${orbId} answered by orb ${response.orbId}`,
    };
  }
  const last = response.records.at(-1);
  if (last === undefined) {
    if (response.cursor !== after) {
      return {
        type: "replication_integrity",
        reason: "mapping_failure",
        message: `empty response must echo cursor ${JSON.stringify(after)}, got ${JSON.stringify(response.cursor)}`,
      };
    }
    return null;
  }
  if (response.cursor !== last.id) {
    return {
      type: "replication_integrity",
      reason: "mapping_failure",
      message: `cursor ${JSON.stringify(response.cursor)} does not match final record ${last.id}`,
    };
  }
  return null;
}

/**
 * Stop the host and mark the orb `failed` with a typed error — the shared
 * non-retryable integrity path (DESIGN.md §8.4). The host stop is attempted
 * here; the failed-state reconciler is the crash-safety backstop.
 */
export async function failOrbForIntegrity(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orbId: string,
  error: ReplicationIntegrityError,
): Promise<void> {
  for (;;) {
    const orbResult = await deps.store.getOrb(task, orbId);
    if (orbResult.isErr()) {
      await sleepResult(task, deps.constants.retryBackoffBaseMs, "integrity fail: store retry");
      continue;
    }
    const orb = orbResult.value;
    if (orb === null || orb.state === "failed" || orb.state === "stopped") return;
    if (orb.hostRef !== null) {
      const ref: OrbHostRef = { provider: deps.hostProvider.kind, resourceId: orb.hostRef };
      // Best effort: a failure here is repaired by the failed-state backstop.
      await withDeadline(
        task,
        deps.constants.providerOperationTimeoutMs,
        "integrity fail: stop host",
        (context) => deps.hostProvider.stop(task, ref, context),
      );
    }
    const cas = await deps.store.casTransition(task, {
      orbId,
      expectedStateVersion: orb.stateVersion,
      toState: "failed",
      now: task.wallNow(),
      lastError: formatOrbFailure("replication_integrity", `${error.reason}: ${error.message}`),
    });
    if (cas.isOk()) {
      deps.control.clearOrb(orbId);
      return;
    }
    if (cas.error.type === "state_conflict") {
      await task.checkpoint("integrity fail: state conflict, re-reading");
      continue;
    }
    await sleepResult(task, deps.constants.retryBackoffBaseMs, "integrity fail: cas retry");
  }
}

/**
 * Pull one orb from its committed cursor until the runtime returns no new
 * complete records (DESIGN.md §8.1/§8.2). Non-empty commits loop immediately;
 * cursor conflicts re-read and continue (another poller won); retryable
 * failures return to the ordinary polling cadence with the cursor unchanged.
 */
export async function pollOrbUntilCaughtUp(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orbId: string,
): Promise<PollOutcome> {
  let committedRecords = 0;
  for (;;) {
    const orbResult = await deps.store.getOrb(task, orbId);
    if (orbResult.isErr()) return { type: "retryable", message: orbResult.error.message };
    const orb = orbResult.value;
    if (orb === null || (orb.state !== "running" && orb.state !== "stopping")) {
      return { type: "orb_gone" };
    }
    const hostRef = orb.hostRef;
    if (hostRef === null) return { type: "retryable", message: "orb has no host yet" };
    const ref: OrbHostRef = { provider: deps.hostProvider.kind, resourceId: hostRef };

    const observed = await withDeadline(
      task,
      deps.constants.providerOperationTimeoutMs,
      "observe host for pull",
      (context) => deps.hostProvider.observe(task, ref, context),
    );
    if (observed.isErr()) return { type: "retryable", message: observed.error.message };
    const observation = observed.value;
    if (
      observation === null ||
      observation.state !== "running" ||
      observation.runtimeAddress === undefined
    ) {
      return { type: "retryable", message: "host is not running" };
    }
    const baseUrl = observation.runtimeAddress.baseUrl;

    const pulled = await withDeadline(
      task,
      deps.constants.runtimeRequestTimeoutMs,
      "history pull request",
      (context) =>
        deps.runtimeClient.pullHistory(
          task,
          { baseUrl, after: orb.replicationCursor, limit: deps.constants.pullLimit },
          context,
        ),
    );
    if (pulled.isErr()) {
      const error = pulled.error;
      if (error.code === "cursor_not_found") {
        const integrity: ReplicationIntegrityError = {
          type: "replication_integrity",
          reason: "cursor_not_found",
          message: error.message,
        };
        await failOrbForIntegrity(task, deps, orbId, integrity);
        return { type: "integrity", reason: "cursor_not_found" };
      }
      if (error.code === "invalid_response") {
        const integrity: ReplicationIntegrityError = {
          type: "replication_integrity",
          reason: "mapping_failure",
          message: error.message,
        };
        await failOrbForIntegrity(task, deps, orbId, integrity);
        return { type: "integrity", reason: "mapping_failure" };
      }
      return { type: "retryable", message: error.message };
    }
    const response = pulled.value;

    const invalid = validatePullResponse(orbId, orb.replicationCursor, response);
    if (invalid !== null) {
      await failOrbForIntegrity(task, deps, orbId, invalid);
      return { type: "integrity", reason: invalid.reason };
    }

    // A successful pull is the running-orb liveness/activity signal.
    deps.control.recordPullSuccess(
      orbId,
      task.monotonicNow(),
      response.activity,
      response.runtimeInstanceId,
    );

    if (response.records.length === 0) {
      const verified = await deps.store.initOrVerifySession(task, orbId, response.session);
      if (verified.isErr()) {
        const error = verified.error;
        if (error.type === "replication_integrity") {
          await failOrbForIntegrity(task, deps, orbId, error);
          return { type: "integrity", reason: error.reason };
        }
        return { type: "retryable", message: error.message };
      }
      return { type: "caught_up", committedRecords };
    }

    const last = response.records.at(-1);
    if (last === undefined) return { type: "retryable", message: "unreachable" };
    const committed = await deps.store.commitPullBatch(task, {
      orbId,
      expectedCursor: orb.replicationCursor,
      session: response.session,
      records: response.records,
      nextCursor: last.id,
      nextHeadId: response.headId,
    });
    if (committed.isErr()) {
      const error = committed.error;
      if (error.type === "cursor_conflict") {
        // Another poller advanced the cursor first; start over from the new one.
        await task.checkpoint("cursor conflict: repolling from fresh cursor");
        continue;
      }
      if (error.type === "replication_integrity") {
        await failOrbForIntegrity(task, deps, orbId, error);
        return { type: "integrity", reason: error.reason };
      }
      return { type: "retryable", message: error.message };
    }
    committedRecords += response.records.length;
    await task.checkpoint("committed pull batch");
    // Non-empty response: pull again immediately to reduce lag.
  }
}

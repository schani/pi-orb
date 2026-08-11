import type { SimulationTask } from "determined";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import type { StoreError } from "./errors.ts";
import { logProjectEvent } from "./log.ts";
import type { ProjectRow } from "./orb.ts";
import type { ControlPlaneDeps } from "./ports.ts";

export interface ProjectCommandError {
  readonly type: "command_error";
  /** `internal` is a deterministic store bug (`StoreError` code `invariant`): never retryable. */
  readonly code: "not_found" | "conflict" | "unavailable" | "internal";
  readonly message: string;
  readonly retryable: boolean;
}

const commandError = (
  code: ProjectCommandError["code"],
  message: string,
  retryable: boolean,
): ProjectCommandError => ({ type: "command_error", code, message, retryable });

const storeCommandError = (error: StoreError): ProjectCommandError =>
  error.code === "invariant"
    ? commandError("internal", error.message, false)
    : commandError("unavailable", error.message, error.retryable);

/**
 * Atomically fence child creation and fan permanent deletion out to every
 * current child (docs/project-deletion.md). The same store operation is also
 * the repair primitive used after process failure.
 */
export function requestProjectDeletion(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  projectId: string,
): ResultAsync<ProjectRow, ProjectCommandError> {
  const run = async (): Promise<Result<ProjectRow, ProjectCommandError>> => {
    const now = task.wallNow();
    const requested = await deps.store.requestProjectDeletion(task, {
      projectId,
      now,
      cleanupAfter: now + deps.constants.deletionQuarantineMs,
    });
    if (requested.isErr()) {
      if (requested.error.type === "project_conflict") {
        return requested.error.reason === "not_found"
          ? err(commandError("not_found", `project ${projectId} not found`, false))
          : err(commandError("conflict", "project deletion conflicted", true));
      }
      return err(storeCommandError(requested.error));
    }
    for (const orb of requested.value.orbs) {
      deps.control.markStopping(orb.id);
      deps.control.closeBrowserConnections(orb.id);
      deps.control.setNextAttemptAt(`reconcile:${orb.id}`, 0);
    }
    if (requested.value.newlyRequested) {
      logProjectEvent(task, projectId, "deletion-requested", {
        children: requested.value.project.deletionInitialOrbCount ?? 0,
      });
    } else if (requested.value.repaired > 0) {
      logProjectEvent(task, projectId, "deletion-fanout-repaired", {
        children: requested.value.repaired,
      });
    }
    return ok(requested.value.project);
  };
  return new ResultAsync(run());
}

export type ProjectDeletionOutcome =
  | { readonly type: "noop" }
  | { readonly type: "waiting" }
  | {
      readonly type: "retryable";
      readonly message: string;
      /** No retry can clear this one: a `StoreError` with code `invariant`. */
      readonly invariant?: boolean;
    }
  | { readonly type: "finalized" };

/** Classify a store failure into the retry channel, preserving `invariant`. */
const storeRetry = (error: StoreError): ProjectDeletionOutcome =>
  error.code === "invariant"
    ? { type: "retryable", message: error.message, invariant: true }
    : { type: "retryable", message: error.message };

/** One recoverable project-finalization pass. Child cleanup stays orb-owned. */
export async function reconcileProjectDeletionOnce(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  projectId: string,
): Promise<ProjectDeletionOutcome> {
  const now = task.wallNow();
  const repaired = await deps.store.requestProjectDeletion(task, {
    projectId,
    now,
    cleanupAfter: now + deps.constants.deletionQuarantineMs,
  });
  if (repaired.isErr()) {
    if (repaired.error.type === "project_conflict" && repaired.error.reason === "not_found") {
      return { type: "noop" };
    }
    return repaired.error.type === "store_error"
      ? storeRetry(repaired.error)
      : {
          type: "retryable",
          message: `project deletion repair conflict: ${repaired.error.reason}`,
        };
  }
  if (!repaired.value.newlyRequested && repaired.value.repaired > 0) {
    logProjectEvent(task, projectId, "deletion-fanout-repaired", {
      children: repaired.value.repaired,
    });
  }
  for (const orb of repaired.value.orbs) {
    deps.control.markStopping(orb.id);
    deps.control.closeBrowserConnections(orb.id);
    deps.control.setNextAttemptAt(`reconcile:${orb.id}`, 0);
  }
  const progress = await deps.store.getProjectDeletionProgress(task, projectId);
  if (progress.isErr()) {
    return progress.error.type === "store_error"
      ? storeRetry(progress.error)
      : { type: "retryable", message: `project progress conflict: ${progress.error.reason}` };
  }
  const blockerKey = `project-delete-blocked:${projectId}`;
  if (deps.control.noteCondition(blockerKey, progress.value.blocked > 0)) {
    logProjectEvent(
      task,
      projectId,
      progress.value.blocked > 0 ? "deletion-blocked" : "deletion-recovered",
      { blocked: progress.value.blocked, remaining: progress.value.remaining },
    );
  }
  if (progress.value.remaining > 0) return { type: "waiting" };
  const finalized = await deps.store.finalizeProjectDeletion(task, {
    projectId,
    expectedStateVersion: repaired.value.project.stateVersion,
  });
  if (finalized.isErr()) {
    if (
      finalized.error.type === "project_conflict" &&
      finalized.error.reason === "children_remain"
    ) {
      return { type: "waiting" };
    }
    return finalized.error.type === "store_error"
      ? storeRetry(finalized.error)
      : { type: "retryable", message: `project finalization conflict: ${finalized.error.reason}` };
  }
  logProjectEvent(task, projectId, "deleted", { outcome: "all_children_resources_removed" });
  return { type: "finalized" };
}

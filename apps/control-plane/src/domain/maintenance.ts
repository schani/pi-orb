import type { OrbState } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, type Result } from "neverthrow";
import { withDeadline } from "./dst.ts";
import { reconcileMaintenanceOrbOnce } from "./lifecycle.ts";
import type { ControlPlaneDeps } from "./ports.ts";

export interface MaintenanceError {
  readonly type: "maintenance_error";
  readonly code: "store" | "storage" | "unsafe" | "timeout" | "invalid";
}
export interface MaintenanceOrb {
  id: string;
  projectId: string;
  state: OrbState;
  stateVersion: number;
  hostRef: string | null;
  hostIncarnation: number;
  replicationCursor: string | null;
  replicatedHeadId: string | null;
  sleepId: string | null;
  sleepUntil: number | null;
  discardThrough: number | null;
  disposal: "archive" | "delete" | null;
  historySealedAt: number | null;
  cleanupAfter: number | null;
  messages: { id: string; wake: boolean }[];
}
export interface MaintenanceSnapshot {
  releaseId: string;
  phase: string;
  projects: { id: string; ownerUserId: string }[];
  orbs: MaintenanceOrb[];
  resumeCandidates: { orbId: string; stateVersion: number }[];
}
export interface MaintenanceReceipt {
  receiptUri: string;
  generation: string;
  sha256: string;
}
export interface MaintenanceReceipts {
  seal(
    key: string,
    snapshot: MaintenanceSnapshot,
  ): Promise<Result<MaintenanceReceipt, MaintenanceError>>;
}
const STATES: OrbState[] = [
  "creating",
  "starting",
  "running",
  "stopping",
  "stopped",
  "failed",
  "archiving",
  "archived",
  "deleting",
];
const failure = (code: MaintenanceError["code"]): MaintenanceError => ({
  type: "maintenance_error",
  code,
});

export async function inventoryMaintenance(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  releaseId: string,
  phase: string,
  baseline?: MaintenanceSnapshot,
): Promise<Result<MaintenanceSnapshot, MaintenanceError>> {
  if (baseline && (baseline.releaseId !== releaseId || baseline.phase !== "drain"))
    return err(failure("invalid"));
  const projects = await deps.store.listProjects(task);
  const orbs = await deps.store.listOrbsInStates(task, STATES);
  if (projects.isErr() || orbs.isErr()) return err(failure("store"));
  const snapshot: MaintenanceSnapshot = {
    releaseId,
    phase,
    projects: projects.value.map(({ id, ownerUserId }) => ({ id, ownerUserId })),
    orbs: [],
    resumeCandidates: [],
  };
  for (const orb of orbs.value) {
    const messages = await deps.store.listOrbMessages(task, orb.id);
    const disposal = await deps.store.getOrbDeletion(task, orb.id);
    if (messages.isErr() || disposal.isErr()) return err(failure("store"));
    snapshot.orbs.push({
      id: orb.id,
      projectId: orb.projectId,
      state: orb.state,
      stateVersion: orb.stateVersion,
      hostRef: orb.hostRef,
      hostIncarnation: orb.hostIncarnation,
      replicationCursor: orb.replicationCursor,
      replicatedHeadId: orb.replicatedHeadId,
      sleepId: orb.sleepId,
      sleepUntil: orb.sleepUntil,
      discardThrough: orb.hostDiscardThroughIncarnation,
      disposal: disposal.value?.kind ?? null,
      historySealedAt: disposal.value?.historySealedAt ?? null,
      cleanupAfter: disposal.value?.cleanupAfter ?? null,
      messages: messages.value
        .filter((m) => m.status === "queued" || m.status === "delivering")
        .map((m) => ({ id: m.messageId, wake: m.autoStart })),
    });
    await task.checkpoint("maintenance.inventory-orb", orb.id, orb.stateVersion);
  }
  snapshot.resumeCandidates = (baseline?.resumeCandidates ?? []).filter((candidate) =>
    snapshot.orbs.some(
      (orb) =>
        orb.id === candidate.orbId &&
        orb.state === "stopped" &&
        orb.stateVersion === candidate.stateVersion,
    ),
  );
  return ok(snapshot);
}

export async function drainMaintenance(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  receipts: MaintenanceReceipts,
  releaseId: string,
  timeoutMs: number,
): Promise<Result<MaintenanceSnapshot, MaintenanceError>> {
  const before = await inventoryMaintenance(task, deps, releaseId, "drain");
  if (before.isErr()) return before;
  const sealed = await receipts.seal("pre", before.value);
  if (sealed.isErr()) return err(sealed.error);
  const deadline = task.monotonicNow() + timeoutMs;
  const admitted = new Set(before.value.orbs.map((orb) => orb.id));
  const stoppedVersions = new Map<string, number>();
  for (;;) {
    if (task.monotonicNow() >= deadline) return err(failure("timeout"));
    const rows = await deps.store.listOrbsInStates(task, STATES);
    if (rows.isErr()) return err(failure("store"));
    let pending = false;
    for (const orb of rows.value) {
      if (["creating", "starting", "running"].includes(orb.state)) {
        if (!admitted.has(orb.id) && orb.hostRef === null && orb.state === "creating") continue;
        const stopped = await deps.store.casMaintenanceStop(task, {
          orbId: orb.id,
          expectedStateVersion: orb.stateVersion,
          now: task.wallNow(),
        });
        if (stopped.isErr() && stopped.error.type !== "state_conflict")
          return err(failure("store"));
        await task.failpoint("maintenance.after-stop-cas");
        if (stopped.isOk()) {
          stoppedVersions.set(orb.id, stopped.value.stateVersion);
          const outcome = await inventoryMaintenance(task, deps, releaseId, "stop");
          if (outcome.isErr()) return outcome;
          const receipt = await receipts.seal(
            `stop-${orb.id}-${stopped.value.stateVersion}`,
            outcome.value,
          );
          if (receipt.isErr()) return err(receipt.error);
        }
        pending = true;
      } else if (
        ["stopping", "archiving", "deleting"].includes(orb.state) ||
        (orb.hostDiscardThroughIncarnation !== null && orb.state !== "archived")
      ) {
        if (orb.state === "archiving" || orb.state === "deleting") {
          const disposal = await deps.store.getOrbDeletion(task, orb.id);
          if (disposal.isErr()) return err(failure("store"));
          if (
            disposal.value?.historySealedAt !== null &&
            disposal.value?.historySealedAt !== undefined &&
            disposal.value.cleanupAfter > task.wallNow()
          )
            continue;
        }
        const outcome = await reconcileMaintenanceOrbOnce(task, deps, orb.id);
        await task.failpoint("maintenance.after-reconcile");
        if (outcome.type === "transitioned" && outcome.toState === "failed")
          return err(failure("unsafe"));
        pending = true;
      }
    }
    if (!pending) {
      const snapshot = await inventoryMaintenance(task, deps, releaseId, "drain");
      if (snapshot.isErr()) return snapshot;
      const validated = await validateFinalMaintenance(task, deps, snapshot.value);
      if (validated.isErr()) return err(validated.error);
      snapshot.value.resumeCandidates = snapshot.value.orbs
        .filter(
          (orb) =>
            orb.state === "stopped" && orb.stateVersion === (stoppedVersions.get(orb.id) ?? -2) + 1,
        )
        .map((orb) => ({ orbId: orb.id, stateVersion: orb.stateVersion }));
      const postdrain = await receipts.seal("postdrain", snapshot.value);
      return postdrain.isErr() ? err(postdrain.error) : snapshot;
    }
    await task.sleep(1_000, "maintenance drain pass");
  }
}

/** After broker retirement this only inspects; it never repairs or starts compute. */
export async function validateFinalMaintenance(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  snapshot: MaintenanceSnapshot,
): Promise<Result<void, MaintenanceError>> {
  for (const orb of snapshot.orbs) {
    if (
      ["running", "starting", "stopping"].includes(orb.state) ||
      ((orb.state === "archiving" || orb.state === "deleting") && orb.historySealedAt === null) ||
      orb.discardThrough !== null ||
      (orb.state === "creating" && orb.hostRef !== null)
    )
      return err(failure("unsafe"));
    const hostRef = orb.hostRef;
    if (hostRef !== null) {
      const observed = await withDeadline(
        task,
        deps.constants.providerOperationTimeoutMs,
        "maintenance final observe",
        (context) =>
          deps.hostProvider.observe(
            task,
            { provider: deps.hostProvider.kind, resourceId: hostRef },
            context,
          ),
      );
      if (observed.isErr() || (observed.value !== null && observed.value.state !== "stopped"))
        return err(failure("unsafe"));
    }
  }
  return ok(undefined);
}

export interface MaintenanceResumeFence {
  phase: "preapply-resume";
  legacyIntentWritersRetired: boolean;
  candidateExposed: boolean;
}

/** Admission only, while all intent writers and ordinary controllers are off. */
export async function resumeMaintenance(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  snapshot: MaintenanceSnapshot,
  fence: MaintenanceResumeFence,
): Promise<Result<{ resumed: number; deferred: number }, MaintenanceError>> {
  if (
    fence.phase !== "preapply-resume" ||
    !fence.legacyIntentWritersRetired ||
    fence.candidateExposed ||
    snapshot.phase !== "final"
  )
    return err(failure("invalid"));
  const validated = await validateFinalMaintenance(task, deps, snapshot);
  if (validated.isErr()) return err(validated.error);
  const counts = { resumed: 0, deferred: 0 };
  for (const candidate of snapshot.resumeCandidates) {
    const orb = snapshot.orbs.find((row) => row.id === candidate.orbId);
    if (!orb || orb.state !== "stopped" || orb.stateVersion !== candidate.stateVersion)
      return err(failure("invalid"));
    const current = await deps.store.getOrb(task, orb.id);
    if (current.isErr()) return err(failure("store"));
    if (
      !current.value ||
      current.value.state !== "stopped" ||
      current.value.stateVersion !== candidate.stateVersion
    )
      return err(failure("unsafe"));
    if (orb.sleepId !== null) {
      counts.deferred++;
      continue;
    }
    const resumed = await deps.store.casMaintenanceResume(task, {
      orbId: orb.id,
      expectedStateVersion: candidate.stateVersion,
      now: task.wallNow(),
    });
    if (resumed.isErr())
      return err(failure(resumed.error.type === "state_conflict" ? "unsafe" : "store"));
    counts.resumed++;
    await task.failpoint("maintenance.after-resume-cas");
  }
  return ok(counts);
}

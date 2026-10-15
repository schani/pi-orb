import { createHash } from "node:crypto";
import type { OrbSelf, OrbSpawnRequest } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, errAsync, type ResultAsync } from "neverthrow";
import type { StoreError } from "./errors.ts";
import { logOrbEvent } from "./log.ts";
import { newOrbRow } from "./new-orb.ts";
import type { OrbRow } from "./orb.ts";
import { type SpawnModelError, spawnModelHarness } from "./orb-spawn-model.ts";
import type { ArchiveCaller, ControlPlaneDeps, ControlPlaneStore, SpawnConflict } from "./ports.ts";

export function spawnOrb(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  caller: OrbRow,
  orbId: string,
  request: OrbSpawnRequest,
  authority?: ArchiveCaller,
): ResultAsync<void, StoreError | SpawnConflict | SpawnModelError> {
  const initialModel = request.model ?? null;
  const selectedHarness =
    initialModel === null ? caller.harness : spawnModelHarness(initialModel.provider);
  if (selectedHarness === null)
    return errAsync({
      type: "spawn_model_error",
      reason: "invalid",
      message: "Unsupported spawn model provider.",
    });
  const harness = selectedHarness;
  const requestHash = createHash("sha256")
    .update(
      JSON.stringify([
        request.prompt,
        request.name ?? null,
        initialModel === null ? null : [initialModel.provider, initialModel.id],
      ]),
    )
    .digest("hex");
  if (initialModel === null) return admit();
  return deps.store.getSpawnCaller(task, orbId).andThen((acceptedCaller) => {
    if (acceptedCaller !== null) return admit();
    return deps.store.getProject(task, caller.projectId).andThen((project) => {
      if (project === null || project.state !== "active")
        return err<void, SpawnConflict>({ type: "spawn_conflict", reason: "conflict" });
      return deps
        .checkSpawnModel(task, project.ownerUserId, initialModel)
        .andThen(() => admit(project.ownerUserId));
    });
  });

  function admit(expectedOwnerUserId?: string): ResultAsync<void, StoreError | SpawnConflict> {
    const orb = newOrbRow(
      {
        orbId,
        projectId: caller.projectId,
        harness,
        initialModel,
        ...(request.name === undefined ? {} : { name: request.name }),
      },
      deps.hostProvider.kind,
      task.wallNow(),
    );
    return deps.store
      .spawnOrb(task, {
        callerOrbId: caller.id,
        ...(expectedOwnerUserId === undefined ? {} : { expectedOwnerUserId }),
        caller: authority ?? {
          runtimeTokenHash: caller.runtimeTokenHash ?? "",
          hostIncarnation: caller.hostIncarnation,
        },
        orb,
        prompt: request.prompt,
        requestHash,
      })
      .map(({ duplicate }) => {
        deps.control.nudgeNextAttemptAt(`reconcile:${orbId}`);
        // The transaction's orb_spawns row is the durable acceptance/provenance record.
        if (!duplicate)
          logOrbEvent(task, orbId, "spawn-accepted", {
            caller: caller.id,
            message: orbId,
            project: caller.projectId,
            harness,
            model:
              initialModel === null ? undefined : `${initialModel.provider}/${initialModel.id}`,
          });
        return undefined;
      });
  }
}

export function getOrbSpawnRelations(
  task: SimulationTask,
  store: Pick<ControlPlaneStore, "getSpawnCaller" | "listSpawnChildren">,
  orbId: string,
  appOrigin: string,
): ResultAsync<Pick<OrbSelf, "spawnedBy" | "children">, StoreError> {
  const url = (id: string) => `${appOrigin}/orbs/${id}`;
  return store.getSpawnCaller(task, orbId).andThen((callerId) =>
    store.listSpawnChildren(task, orbId).map((children) => ({
      spawnedBy: callerId === null ? null : { id: callerId, url: url(callerId) },
      children: children.map((child) => ({ ...child, url: url(child.id) })),
    })),
  );
}

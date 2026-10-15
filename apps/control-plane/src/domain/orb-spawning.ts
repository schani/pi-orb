import { createHash } from "node:crypto";
import type { OrbSelf, OrbSpawnRequest } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, errAsync, type ResultAsync } from "neverthrow";
import type { StoreError } from "./errors.ts";
import { logOrbEvent } from "./log.ts";
import { newOrbRow } from "./new-orb.ts";
import type { OrbRow } from "./orb.ts";
import { resolveSpawnModel, type SpawnModelError, spawnModelError } from "./orb-spawn-model.ts";
import type { ArchiveCaller, ControlPlaneDeps, ControlPlaneStore, SpawnConflict } from "./ports.ts";

export function spawnOrb(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  caller: OrbRow,
  orbId: string,
  request: OrbSpawnRequest,
  authority?: ArchiveCaller,
): ResultAsync<void, StoreError | SpawnConflict | SpawnModelError> {
  const requestHash = (model: OrbRow["initialModel"]) =>
    createHash("sha256")
      .update(
        JSON.stringify([
          request.prompt,
          request.name ?? null,
          typeof request.model === "object"
            ? [request.model.provider, request.model.id]
            : (request.model ?? null),
          model === null ? null : [model.provider, model.id],
        ]),
      )
      .digest("hex");
  return deps.store.getSpawnAcceptance(task, orbId).andThen((accepted) => {
    if (accepted !== null) {
      if (
        accepted.callerOrbId !== caller.id ||
        accepted.requestHash !== requestHash(accepted.initialModel)
      )
        return err<void, SpawnConflict>({ type: "spawn_conflict", reason: "conflict" });
      return admit(accepted.initialModel);
    }
    if (request.model === undefined) return admit(null);
    const selector = request.model;
    return deps.store.getProject(task, caller.projectId).andThen((project) => {
      if (project === null || project.state !== "active")
        return err<void, SpawnConflict>({ type: "spawn_conflict", reason: "conflict" });
      return deps.spawnModels
        .read(task, project.ownerUserId, selector)
        .andThen((catalog) => resolveSpawnModel(selector, catalog))
        .andThen(({ model }) => admit(model, project.ownerUserId));
    });
  });

  function admit(
    initialModel: OrbRow["initialModel"],
    expectedOwnerUserId?: string,
  ): ResultAsync<void, StoreError | SpawnConflict | SpawnModelError> {
    const harness =
      initialModel === null
        ? caller.harness
        : initialModel.provider === "openai-codex"
          ? "pi"
          : initialModel.provider === "claude"
            ? "claude"
            : null;
    if (harness === null)
      return errAsync(spawnModelError("invalid", "Unsupported spawn model provider."));
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
        requestHash: requestHash(initialModel),
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

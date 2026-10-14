import type { SimulationTask } from "determined";
import { okAsync, type ResultAsync } from "neverthrow";
import type { StoreError } from "./errors.ts";
import type { OrbListRow } from "./orb.ts";
import type { ControlPlaneStore } from "./ports.ts";

export function readProjectOrbs(
  task: SimulationTask,
  store: Pick<ControlPlaneStore, "getProject" | "listOrbsByProject">,
  projectId: string,
): ResultAsync<OrbListRow[] | null, StoreError> {
  return store
    .getProject(task, projectId)
    .andThen((project) =>
      project === null
        ? okAsync<OrbListRow[] | null, StoreError>(null)
        : store.listOrbsByProject(task, projectId),
    );
}

export function readOrb(
  task: SimulationTask,
  store: Pick<ControlPlaneStore, "getOrb" | "getSpawnCaller">,
  orbId: string,
): ResultAsync<OrbListRow | null, StoreError> {
  return store
    .getOrb(task, orbId)
    .andThen((orb) =>
      orb === null
        ? okAsync<OrbListRow | null, StoreError>(null)
        : store.getSpawnCaller(task, orbId).map((spawnedBy) => ({ ...orb, spawnedBy })),
    );
}

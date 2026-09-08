import { createHash } from "node:crypto";
import type { OrbSpawnRequest } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import type { ResultAsync } from "neverthrow";
import type { StoreError } from "./errors.ts";
import { logOrbEvent } from "./log.ts";
import { newOrbRow } from "./new-orb.ts";
import type { OrbRow } from "./orb.ts";
import type { ControlPlaneDeps, SpawnConflict } from "./ports.ts";

export function spawnOrb(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  caller: OrbRow,
  orbId: string,
  request: OrbSpawnRequest,
): ResultAsync<void, StoreError | SpawnConflict> {
  const orb = newOrbRow(
    {
      orbId,
      projectId: caller.projectId,
      ...(request.name === undefined ? {} : { name: request.name }),
    },
    deps.hostProvider.kind,
    task.wallNow(),
  );
  const requestHash = createHash("sha256")
    .update(JSON.stringify([request.prompt, request.name ?? null]))
    .digest("hex");
  return deps.store
    .spawnOrb(task, {
      callerOrbId: caller.id,
      caller: {
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
        });
      return undefined;
    });
}

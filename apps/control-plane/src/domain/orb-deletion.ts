import { OrbDeleteRequestSchema } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { errAsync, type ResultAsync } from "neverthrow";
import { Check } from "typebox/value";
import { type CommandError, requestOrbDeletion } from "./lifecycle.ts";
import type { OrbRow } from "./orb.ts";
import type { ControlPlaneDeps, OrbMessageSender } from "./ports.ts";

export type OrbDeletionError =
  | CommandError
  | {
      readonly type: "command_error";
      readonly code: "invalid_request";
      readonly message: string;
      readonly retryable: false;
    };

/** The source is bound by authentication, never taken from the delete request. */
export function deleteOrbFromAgent(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  source: OrbMessageSender,
  request: unknown,
): ResultAsync<OrbRow, OrbDeletionError> {
  if (!Check(OrbDeleteRequestSchema, request))
    return errAsync({
      type: "command_error",
      code: "invalid_request",
      message: "specify exactly {self:true} or {orbId:full UUID}",
      retryable: false,
    });
  if ("self" in request) return requestOrbDeletion(task, deps, source.orbId, source.caller);
  const targetId = request.orbId.toLowerCase();
  if (targetId === source.orbId.toLowerCase())
    return errAsync({
      type: "command_error",
      code: "invalid_request",
      message: "use {self:true} to delete this orb",
      retryable: false,
    });
  return deps.store
    .listOrbDescendants(task, source)
    .mapErr(
      (error): OrbDeletionError => ({
        type: "command_error",
        code: error.retryable ? "unavailable" : "internal",
        message: "descendant lookup unavailable",
        retryable: error.retryable,
      }),
    )
    .andThen((descendants) =>
      descendants.some((orb) => orb.id === targetId)
        ? requestOrbDeletion(task, deps, targetId, undefined, source)
        : errAsync({
            type: "command_error" as const,
            code: "not_found" as const,
            message: "descendant orb doesn't exist",
            retryable: false,
          }),
    );
}

export function deleteGuestOrb(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  source: OrbRow,
  request: unknown,
): ResultAsync<OrbRow, OrbDeletionError> {
  return deps.store
    .getProject(task, source.projectId)
    .mapErr(
      (error): OrbDeletionError => ({
        type: "command_error",
        code: error.retryable ? "unavailable" : "internal",
        message: "deletion unavailable",
        retryable: error.retryable,
      }),
    )
    .andThen((project) =>
      project === null
        ? errAsync({
            type: "command_error" as const,
            code: "not_found" as const,
            message: "source project doesn't exist",
            retryable: false,
          })
        : deleteOrbFromAgent(
            task,
            deps,
            {
              orbId: source.id,
              projectId: source.projectId,
              ownerUserId: project.ownerUserId,
              caller: {
                runtimeTokenHash: source.runtimeTokenHash ?? "",
                hostIncarnation: source.hostIncarnation,
              },
            },
            request,
          ),
    );
}

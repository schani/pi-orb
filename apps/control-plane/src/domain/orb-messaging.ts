import { ORB_SEND_MAX_BYTES, ORB_SPAWN_UUID } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { errAsync, type ResultAsync } from "neverthrow";
import { logOrbEvent } from "./log.ts";
import type { OrbAgentError } from "./orb-agent-operations.ts";
import { orbToolRequestId } from "./orb-tool-request-id.ts";
import type { ControlPlaneDeps, OrbMessageSender } from "./ports.ts";

/** Admission, including caller revocation and wake intent, commits in one store transaction. */
export function sendOrbMessage(
  task: SimulationTask,
  deps: Pick<ControlPlaneDeps, "store" | "control">,
  sender: OrbMessageSender,
  request: { orbId: string; message: string; messageId: string },
): ResultAsync<{ orbId: string; messageId: string }, OrbAgentError> {
  if (!ORB_SPAWN_UUID.test(request.orbId))
    return errAsync({ code: "invalid_request", message: "valid target orb UUID required" });
  if (!request.message.trim() || Buffer.byteLength(request.message) > ORB_SEND_MAX_BYTES)
    return errAsync({ code: "invalid_request", message: "message required within byte limit" });
  const orbId = request.orbId.toLowerCase();
  return deps.store
    .enqueueOrbMessage(task, {
      orbId,
      messageId: request.messageId,
      content: [{ type: "text", text: request.message }],
      sender,
      now: task.wallNow(),
    })
    .mapErr(
      (error): OrbAgentError =>
        error.type === "orb_message_target_not_found"
          ? { code: "not_found", message: "target orb doesn't exist" }
          : error.type === "state_conflict"
            ? {
                code: "conflict",
                message: "sender or target no longer permits messaging, or request conflicts",
              }
            : {
                code: error.retryable ? "unavailable" : "internal",
                message: "message acceptance unknown; retry with the same request ID",
              },
    )
    .map(({ message, duplicate }) => {
      if (!duplicate) {
        deps.control.nudgeNextAttemptAt(`reconcile:${orbId}`);
        logOrbEvent(task, orbId, "message-accepted", {
          sender: sender.orbId,
          message: message.messageId,
        });
      }
      return { orbId, messageId: message.messageId };
    });
}

export function sendGuestOrbMessage(
  task: SimulationTask,
  deps: Pick<ControlPlaneDeps, "store" | "control">,
  source: import("./orb.ts").OrbRow,
  request: import("@pi-orb/protocol").OrbSendRequest,
): ResultAsync<{ orbId: string; messageId: string }, OrbAgentError> {
  return deps.store
    .getProject(task, source.projectId)
    .mapErr((): OrbAgentError => ({ code: "unavailable", message: "messaging unavailable" }))
    .andThen((project) =>
      project === null
        ? errAsync({ code: "unauthorized" as const, message: "sender project missing" })
        : sendOrbMessage(
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
            { ...request, messageId: orbToolRequestId(source.id, request.requestId) },
          ),
    );
}

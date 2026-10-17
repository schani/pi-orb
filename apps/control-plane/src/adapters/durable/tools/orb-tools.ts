import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  ROOT_CONVERSATION_ID,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { OrbSpawnRequestSchema } from "@pi-orb/protocol";
import { errAsync, type ResultAsync } from "neverthrow";
import type {
  OrbAgentError,
  OrbAgentOperations,
  OrbAgentRequest,
} from "../../../domain/orb-agent-operations.ts";
import type { ParentNotification } from "../notifications.ts";

/** Calls the application service directly, never a guest CLI or runtime HTTP endpoint. */
export function createOrbTools(service: OrbAgentOperations, notifyParent?: ParentNotification) {
  const resultOutput = (result: Awaited<ResultAsync<unknown, OrbAgentError>>) => ({
    output: [
      {
        type: "text" as const,
        text: JSON.stringify(result.isOk() ? result.value : { error: result.error }),
      },
    ],
    ...(result.isErr() ? { isError: true } : {}),
  });
  const output = async (request: OrbAgentRequest, api: ToolExecutionApi) => {
    const result = await service.invoke(request, JSON.stringify([api.taskId, api.callId]));
    return resultOutput(result);
  };
  const empty = Type.Object({}, { additionalProperties: false });
  return [
    defineTool({
      name: "orb_self",
      description: "Get this orb's identity, project, parent provenance, direct children and URLs.",
      parameters: empty,
      replay: "safe",
      execute: async (_args, api) => output({ kind: "self" }, api),
    }),
    defineTool({
      name: "orb_list",
      description: "List orbs owned by this orb's owner.",
      parameters: empty,
      replay: "safe",
      execute: async (_args, api) => output({ kind: "list" }, api),
    }),
    defineTool({
      name: "orb_transcript",
      description: "Read an orb's committed transcript by ID.",
      parameters: Type.Object({ orbId: Type.String() }, { additionalProperties: false }),
      replay: "safe",
      execute: async (args, api) => output({ kind: "transcript", ...args }, api),
    }),
    defineTool({
      name: "orb_spawn",
      description: "Create a same-project orb with a prompt. Orbs do not share workspaces.",
      parameters: OrbSpawnRequestSchema,
      replay: "safe",
      execute: async (args, api) => output({ kind: "spawn", ...args }, api),
    }),
    defineTool({
      name: "orb_send",
      description:
        "Queue non-human input to a same-owner, same-project orb and wake it. Acceptance is not a reply.",
      parameters: Type.Object(
        { orbId: Type.String(), message: Type.String() },
        { additionalProperties: false },
      ),
      replay: "safe",
      execute: async (args, api) => output({ kind: "send", ...args }, api),
    }),
    defineTool({
      name: "orb_alert",
      description:
        "Notify the parent conversation privately from a subagent; otherwise append a transcript alert and flag this orb. Alerts are not sent to the parent orb.",
      parameters: Type.Object({ message: Type.String() }, { additionalProperties: false }),
      replay: "unsafe",
      execute: async (args, api, context: Context) => {
        if (api.conversationId === ROOT_CONVERSATION_ID)
          return output({ kind: "alert", ...args }, api);
        if (!notifyParent)
          return resultOutput(
            await errAsync({
              code: "unavailable",
              message: "Private notifications unavailable",
            } satisfies OrbAgentError),
          );
        const admitted = await service.invoke(
          { kind: "notification_admission" },
          JSON.stringify([api.taskId, api.callId]),
        );
        return resultOutput(
          admitted.isErr() ? admitted : await notifyParent(args.message, api, context),
        );
      },
    }),
    defineTool({
      name: "orb_sleep",
      description: "Commit a sleep deadline for this orb and return without waiting for shutdown.",
      parameters: Type.Object(
        { durationSeconds: Type.Integer({ minimum: 1 }) },
        { additionalProperties: false },
      ),
      replay: "unsafe",
      execute: async (args, api) => output({ kind: "sleep", ...args }, api),
    }),
    defineTool({
      name: "orb_archive",
      description: "Archive this orb only on explicit user request; keep its transcript.",
      parameters: empty,
      replay: "unsafe",
      execute: async (_args, api) => output({ kind: "archive" }, api),
    }),
    defineTool({
      name: "orb_delete",
      description: "Permanently delete this orb only on explicit user request.",
      parameters: empty,
      replay: "unsafe",
      execute: async (_args, api) => output({ kind: "delete" }, api),
    }),
  ];
}

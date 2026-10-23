import type { Context, JsonValue } from "@earendil-works/chord";
import { type TSchema, Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  ROOT_CONVERSATION_ID,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import {
  HistorySearchRequestSchema,
  HistorySearchResultSchema,
  OrbInspectionListSchema,
  OrbSelfSchema,
  OrbSpawnRequestSchema,
  OrbSpawnResponseSchema,
  OrbStateSchema,
  OrbTranscriptSchema,
} from "@pi-orb/protocol";
import { err, type ResultAsync } from "neverthrow";
import type {
  OrbAgentError,
  OrbAgentOperations,
  OrbAgentRequest,
} from "../../../domain/orb-agent-operations.ts";
import type { ParentNotification } from "../notifications.ts";

/** Calls the application service directly, never a guest CLI or runtime HTTP endpoint. */
export function createOrbTools(service: OrbAgentOperations, notifyParent?: ParentNotification) {
  const resultOutput = (result: Awaited<ResultAsync<unknown, OrbAgentError>>) => {
    const value = result.isOk() ? result.value : { error: result.error };
    return {
      structuredOutput: value as JsonValue,
      output: [{ type: "text" as const, text: JSON.stringify(value) }],
      ...(result.isErr()
        ? {
            isError: true,
            diagnostics: [{ severity: "error" as const, ...result.error }],
          }
        : {}),
    };
  };
  const output = async (request: OrbAgentRequest, api: ToolExecutionApi) => {
    const result = await service.invoke(request, JSON.stringify([api.taskId, api.callId]));
    return resultOutput(result);
  };
  const empty = Type.Object({}, { additionalProperties: false });
  const errorSchema = Type.Object(
    {
      error: Type.Object(
        {
          code: Type.Union([
            Type.Literal("unauthorized"),
            Type.Literal("not_found"),
            Type.Literal("conflict"),
            Type.Literal("unavailable"),
            Type.Literal("internal"),
            Type.Literal("invalid_request"),
          ]),
          message: Type.String(),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  );
  const resultSchema = (success: TSchema) => Type.Union([success, errorSchema]);
  const lifecycleSchema = resultSchema(
    Type.Object({ orbId: Type.String(), state: OrbStateSchema }, { additionalProperties: false }),
  );
  return [
    defineTool({
      name: "orb_self",
      description: "Get this orb's identity, project, parent provenance, direct children and URLs.",
      parameters: empty,
      structuredOutputSchema: resultSchema(Type.Omit(OrbSelfSchema, ["v"])),
      replay: "safe",
      execute: async (_args, api) => output({ kind: "self" }, api),
    }),
    defineTool({
      name: "orb_list",
      description: "List orbs owned by this orb's owner.",
      parameters: empty,
      structuredOutputSchema: resultSchema(Type.Omit(OrbInspectionListSchema, ["v"])),
      replay: "safe",
      execute: async (_args, api) => output({ kind: "list" }, api),
    }),
    defineTool({
      name: "orb_transcript",
      description: "Read an orb's committed transcript by ID.",
      parameters: Type.Object({ orbId: Type.String() }, { additionalProperties: false }),
      structuredOutputSchema: resultSchema(Type.Omit(OrbTranscriptSchema, ["v"])),
      replay: "safe",
      execute: async (args, api) => output({ kind: "transcript", ...args }, api),
    }),
    defineTool({
      name: "orb_search_history",
      description:
        "Search your committed public history with BM25. Defaults to this orb; project searches this project and user searches all your orbs. Returns ranked snippets; use orb_transcript for full context.",
      parameters: HistorySearchRequestSchema,
      structuredOutputSchema: resultSchema(HistorySearchResultSchema),
      replay: "safe",
      execute: async (args, api) => output({ kind: "search", request: args }, api),
    }),
    defineTool({
      name: "orb_spawn",
      description: "Create a same-project orb with a prompt. Orbs do not share workspaces.",
      parameters: OrbSpawnRequestSchema,
      structuredOutputSchema: resultSchema(OrbSpawnResponseSchema),
      replay: "safe",
      execute: async (args, api) => output({ kind: "spawn", ...args }, api),
    }),
    defineTool({
      name: "orb_send",
      description:
        "Send a message to another orb and wake it. Orbs do not share file systems! Acceptance is not a reply.",
      parameters: Type.Object(
        { orbId: Type.String(), message: Type.String() },
        { additionalProperties: false },
      ),
      structuredOutputSchema: resultSchema(
        Type.Object(
          { orbId: Type.String(), messageId: Type.String() },
          { additionalProperties: false },
        ),
      ),
      replay: "safe",
      execute: async (args, api) => output({ kind: "send", ...args }, api),
    }),
    defineTool({
      name: "orb_alert",
      description:
        "Notify the user: append a transcript alert and flag this orb. Alerts are not sent to other agents.",
      parameters: Type.Object({ message: Type.String() }, { additionalProperties: false }),
      structuredOutputSchema: resultSchema(
        Type.Object(
          { recordId: Type.String(), duplicate: Type.Boolean() },
          { additionalProperties: false },
        ),
      ),
      replay: "unsafe",
      execute: async (args, api) => {
        if (api.conversationId !== ROOT_CONVERSATION_ID)
          return resultOutput(
            err({
              code: "unauthorized",
              message: "Only the root conversation can alert the user",
            }),
          );
        return output({ kind: "alert", ...args }, api);
      },
    }),
    defineTool({
      name: "notify_parent",
      description:
        "Notify your parent agent in this orb. Acceptance means durable submission, not a reply.",
      parameters: Type.Object({ message: Type.String() }, { additionalProperties: false }),
      structuredOutputSchema: resultSchema(
        Type.Object({ accepted: Type.Literal(true) }, { additionalProperties: false }),
      ),
      replay: "unsafe",
      execute: async (args, api, context: Context) => {
        if (api.conversationId === ROOT_CONVERSATION_ID)
          return resultOutput(
            err({
              code: "unauthorized",
              message: "Only local subagents can notify a parent",
            }),
          );
        if (!notifyParent)
          return resultOutput(
            err({
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
      structuredOutputSchema: resultSchema(
        Type.Object(
          { sleepId: Type.String(), sleepUntil: Type.Number() },
          { additionalProperties: false },
        ),
      ),
      replay: "unsafe",
      execute: async (args, api) => output({ kind: "sleep", ...args }, api),
    }),
    defineTool({
      name: "orb_archive",
      description: "Archive this orb only on explicit user request; keep its transcript.",
      parameters: empty,
      structuredOutputSchema: lifecycleSchema,
      replay: "unsafe",
      execute: async (_args, api) => output({ kind: "archive" }, api),
    }),
    defineTool({
      name: "orb_delete",
      description: "Permanently delete this orb only on explicit user request.",
      parameters: empty,
      structuredOutputSchema: lifecycleSchema,
      replay: "unsafe",
      execute: async (_args, api) => output({ kind: "delete" }, api),
    }),
  ];
}

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { OrbAgentOperations, OrbAgentRequest } from "../../../domain/orb-agent-operations.ts";

/** Calls the application service directly, never a guest CLI or runtime HTTP endpoint. */
export function createOrbTools(service: OrbAgentOperations) {
  const output = async (request: OrbAgentRequest, api: ToolExecutionApi) => {
    const result = await service.invoke(request, JSON.stringify([api.taskId, api.callId]));
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result.isOk() ? result.value : { error: result.error }),
        },
      ],
      ...(result.isErr() ? { isError: true } : {}),
    };
  };
  const empty = Type.Object({}, { additionalProperties: false });
  return [
    defineTool({
      name: "orb_self",
      description: "Get this orb's identity, project and URLs.",
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
      description: "Create a same-project orb with a prompt.",
      parameters: Type.Object(
        { prompt: Type.String(), name: Type.Optional(Type.String()) },
        { additionalProperties: false },
      ),
      replay: "safe",
      execute: async (args, api) => output({ kind: "spawn", ...args }, api),
    }),
    defineTool({
      name: "orb_alert",
      description: "Append a transcript alert and flag this orb.",
      parameters: Type.Object({ message: Type.String() }, { additionalProperties: false }),
      replay: "unsafe",
      execute: async (args, api) => output({ kind: "alert", ...args }, api),
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

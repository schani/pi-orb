import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { defineExtension, type ToolRegistration } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { ResultAsync } from "neverthrow";
import { type AuthorizeTool, CallableCatalog, type ToolError } from "./catalog.ts";
import { codemodeTool } from "./codemode.ts";
import type { AgentToolFiles } from "./files.ts";
import { type McpEndpoint, McpTools } from "./mcp.ts";

export type { AgentToolFiles } from "./files.ts";

import { imageReadTool } from "./read.ts";
import { ChildAnchor, subagentTools } from "./subagents.ts";

export {
  type AuthorizeTool,
  CallableCatalog,
  type CallableMetadata,
  type ToolError,
} from "./catalog.ts";
export type { McpEndpoint } from "./mcp.ts";
export { ChildAnchor, ChildReceipts, subagentTools } from "./subagents.ts";

export interface DurableToolsOptions {
  authorize?: AuthorizeTool;
  mcp?: readonly McpEndpoint[];
  additionalTools?: readonly ToolRegistration[];
  files?: AgentToolFiles;
}
export function createDurableTools(options: DurableToolsOptions = {}) {
  const catalog = new CallableCatalog(
    [
      ...(CodingTools.tools ?? []),
      imageReadTool(options.files),
      ...subagentTools,
      ...(options.additionalTools ?? []),
    ],
    options.authorize,
  );
  catalog.metadata("bash", {
    outputSchema: {
      type: "object",
      required: ["output", "truncated", "exit_code", "wall_time_seconds"],
      properties: {
        output: { type: "string" },
        truncated: { type: "boolean" },
        full_output_path: { type: "string" },
        exit_code: { type: "number" },
        wall_time_seconds: { type: "number" },
      },
    },
  });
  catalog.metadata("read", {
    outputSchema: {
      anyOf: [
        { type: "string" },
        {
          type: "array",
          items: {
            type: "object",
            required: ["type", "data", "mimeType"],
            properties: {
              type: { const: "image" },
              data: { type: "string" },
              mimeType: { type: "string" },
            },
          },
        },
      ],
    },
  });
  const running = new Set<CodemodeSandbox>();
  const mcp = new McpTools(options.mcp ?? [], catalog);
  catalog.add(mcp.statusTool());
  let code = codemodeTool(catalog, running, options.files);
  const bundle = {
    extension: defineExtension({
      name: "orb.tools",
      tools: [...catalog.registrations(), code],
      tasks: [ChildAnchor],
    }),
    catalog,
    modelTools: [code] as const,
    mcpStatus: () => mcp.status(),
    ready: (context: Context = BACKGROUND_CONTEXT) =>
      ResultAsync.fromSafePromise(mcp.discover(context))
        .andThen((result) => result)
        .map((statuses) => {
          code = codemodeTool(catalog, running, options.files);
          bundle.modelTools = [code];
          bundle.extension = defineExtension({
            name: "orb.tools",
            tools: [...catalog.registrations(), code],
            tasks: [ChildAnchor],
          });
          return statuses;
        }),
    close: (): ResultAsync<void, ToolError> =>
      ResultAsync.fromPromise(
        Promise.all([...running].map((s) => s.close())).then(() => {
          running.clear();
        }),
        () => ({ code: "unavailable" as const, message: "Sandbox cleanup failed" }),
      ).andThen(() => mcp.close()),
  };
  return bundle;
}

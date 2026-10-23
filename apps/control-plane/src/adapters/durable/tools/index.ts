import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { defineExtension, type ToolRegistration } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { SimulationTask } from "determined";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { type AuthorizeTool, CallableCatalog, type ToolError } from "./catalog.ts";
import { codemodeExtension } from "./codemode.ts";
import type { AgentToolFiles } from "./files.ts";
import {
  type McpDiscoveryDiagnostics,
  type McpEndpoint,
  type McpServerStatus,
  type McpStatusChanged,
  McpTools,
} from "./mcp.ts";

export type { AgentToolFiles } from "./files.ts";

import { imageReadTool } from "./read.ts";
import { CHILD_TOOLS_EXTENSION, ChildAnchor, subagentTools, TOOLS_EXTENSION } from "./subagents.ts";

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
  mcpDiscovery?: McpDiscoveryDiagnostics;
  mcpContext?: Context;
  mcpChanged?: McpStatusChanged;
  additionalTools?: readonly ToolRegistration[];
  files?: AgentToolFiles;
  orb?: { id: string; task: SimulationTask };
}
export function createDurableTools(options: DurableToolsOptions = {}) {
  const all = new CallableCatalog(
    [
      ...(CodingTools.tools ?? []),
      imageReadTool(options.files),
      ...subagentTools,
      ...(options.additionalTools ?? []),
    ],
    options.authorize,
  );
  for (const name of ["write", "edit", "mcp_status", ...subagentTools.map((tool) => tool.name)]) {
    all.metadata(name, { ...all.metadata(name), outputSchema: { type: "string" } });
  }
  all.metadata("bash", {
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
  all.metadata("read", {
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
  const catalog = all.without(["notify_parent"]);
  const running = new Set<CodemodeSandbox>();
  const mcp = new McpTools(options.mcp ?? [], catalog, options.mcpDiscovery, (status, previous) => {
    catalog.add(statusTool());
    Object.assign(bundle, extensions());
    return options.mcpChanged?.(status, previous) ?? okAsync(undefined);
  });
  const statusTool = () => mcp.statusTool((ctx) => void bundle.ready(ctx));
  catalog.add(statusTool());
  const child = all.without([...subagentTools.map((tool) => tool.name), "orb_spawn", "orb_alert"]);
  const extensions = () => {
    const native = codemodeExtension(catalog, running, options.files, options.orb);
    const childNative = codemodeExtension(child, running, options.files, options.orb);
    const code = native.tools![0]!;
    return {
      extension: defineExtension({
        ...native,
        name: TOOLS_EXTENSION,
        tools: [...catalog.registrations(), code],
        tasks: [ChildAnchor],
      }),
      childExtension: defineExtension({
        ...childNative,
        name: CHILD_TOOLS_EXTENSION,
        tools: [...child.registrations(), ...childNative.tools!],
      }),
      modelTools: [code] as const,
    };
  };
  let discovery: ResultAsync<readonly McpServerStatus[], ToolError> | undefined;
  let discovering = false;
  let closed = false;
  const bundle = {
    ...extensions(),
    catalog,
    mcpStatus: () => mcp.status(),
    ready: (
      context: Context = BACKGROUND_CONTEXT,
    ): ResultAsync<readonly McpServerStatus[], ToolError> => {
      if (closed) return errAsync({ code: "cancelled", message: "MCP tools closed" });
      if (discovering && discovery) return discovery;
      discovering = true;
      discovery = ResultAsync.fromPromise(
        mcp.discover(options.mcpContext ?? context),
        (): ToolError => ({ code: "unavailable", message: "MCP discovery failed" }),
      )
        .mapErr((error) => {
          discovering = false;
          return error;
        })
        .andThen((result) => {
          discovering = false;
          return result;
        });
      return discovery;
    },
    close: (): ResultAsync<void, ToolError> => {
      closed = true;
      return ResultAsync.combine([
        ResultAsync.fromPromise(
          Promise.all([...running].map((s) => s.close())).then(() => undefined),
          (): ToolError => ({ code: "unavailable", message: "Sandbox cleanup failed" }),
        ),
        mcp.close(),
        discovery
          ? discovery
              .map(() => undefined)
              .orElse((error) =>
                error.code === "cancelled" ? okAsync(undefined) : errAsync(error),
              )
          : okAsync(undefined),
      ]).map(() => undefined);
    },
  };
  return bundle;
}

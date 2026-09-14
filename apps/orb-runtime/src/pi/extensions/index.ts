import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { createMcpExtension, createMcpToolExtension, type McpExtensionDeps } from "./mcp.ts";
import { createSubagentsExtension, type SubagentHost } from "./subagents.ts";

/** Explicit first-party composition; user/project discovery remains Pi-owned. */
export function createOrbExtensions(deps: {
  cwd: string;
  mcp?: McpExtensionDeps;
  subagents?: SubagentHost;
}): InlineExtension[] {
  const mcp = deps.mcp && deps.mcp.configs.length > 0 ? deps.mcp : undefined;
  return [
    // Shutdown drains children before closing the root-owned MCP connections.
    ...(deps.subagents
      ? [
          {
            name: "pi-orb:subagents",
            factory: createSubagentsExtension(
              deps.subagents,
              deps.cwd,
              mcp ? [{ name: "pi-orb:mcp-tools", factory: createMcpToolExtension(mcp) }] : [],
            ),
          },
        ]
      : []),
    ...(mcp ? [{ name: "pi-orb:mcp", factory: createMcpExtension(mcp) }] : []),
  ];
}

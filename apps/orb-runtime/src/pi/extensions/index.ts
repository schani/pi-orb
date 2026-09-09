import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { createMcpExtension, type McpExtensionDeps } from "./mcp.ts";

/** Explicit first-party composition; user/project discovery remains Pi-owned. */
export function createOrbExtensions(deps: { mcp?: McpExtensionDeps }): InlineExtension[] {
  return deps.mcp && deps.mcp.configs.length > 0
    ? [{ name: "pi-orb:mcp", factory: createMcpExtension(deps.mcp) }]
    : [];
}

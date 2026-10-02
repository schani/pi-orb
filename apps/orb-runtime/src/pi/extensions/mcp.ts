import type { McpConfig } from "@pi-orb/protocol";

export {
  createOrbMcpExtension,
  type OrbMcpDiagnostic,
  type OrbMcpExtensionDeps,
  type OrbMcpState,
} from "../../mcp/native.ts";

export function mcpInventoryPrompt(configs: readonly McpConfig[]): string | null {
  return configs.length
    ? `Available MCP servers:\n${configs.map((c) => `- ${c.name}: ${c.description.replace(/[\r\n]/g, " ")}`).join("\n")}`
    : null;
}

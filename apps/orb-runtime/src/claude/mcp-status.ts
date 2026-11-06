import type { SDKSystemMessage } from "@anthropic-ai/claude-agent-sdk";
import { createMcpStateReporter, type OrbMcpState } from "../mcp/transport.ts";

const sources = new Set([
  "sdk",
  "plugin",
  "user",
  "project",
  "local",
  "dynamic",
  "managed",
  "enterprise",
  "claudeai",
  "agent",
]);

/** Per-turn native metadata is distinct from the OAuth bridge's upstream HTTP health. */
export function createClaudeMcpStatusReporter(onState: (event: OrbMcpState) => void) {
  const report = createMcpStateReporter(onState);
  return (servers: SDKSystemMessage["mcp_servers"]) => {
    for (const { name, status, source } of servers) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(name)) continue;
      if (
        status !== "connected" &&
        status !== "failed" &&
        status !== "needs-auth" &&
        status !== "disabled" &&
        status !== "disconnected"
      )
        continue;
      const safeSource = source !== undefined && sources.has(source) ? source : "unknown";
      report(
        name,
        status === "disabled" ? "disconnected" : status,
        `MCP ${name} (${safeSource}): native ${status}`,
        status === "failed"
          ? { code: "connection_failed" }
          : status === "needs-auth"
            ? { code: "auth_required" }
            : undefined,
        { source: safeSource, observation: "native" },
      );
    }
  };
}

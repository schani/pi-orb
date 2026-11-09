import type { SDKSystemMessage } from "@anthropic-ai/claude-agent-sdk";
import type { OrbMcpState } from "../mcp/transport.ts";

export interface ClaudeMcpState extends OrbMcpState {
  message: string;
  source: string;
  observation: "native";
}

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

/** Native metadata does not establish the OAuth bridge's upstream HTTP health. */
export function createClaudeMcpStatusReporter(onState: (event: ClaudeMcpState) => void) {
  const states = new Map<string, Pick<ClaudeMcpState, "state" | "source">>();
  return (servers: SDKSystemMessage["mcp_servers"]) => {
    for (const { name, status, source } of servers) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(name)) continue;
      const state = status === "disabled" ? "disconnected" : status;
      if (
        state !== "connected" &&
        state !== "failed" &&
        state !== "needs-auth" &&
        state !== "disconnected"
      )
        continue;
      const safeSource = source !== undefined && sources.has(source) ? source : "unknown";
      const previous = states.get(name);
      if (previous?.state === state && previous.source === safeSource) continue;
      states.set(name, { state, source: safeSource });
      if (state === "connected" && (!previous || previous.state === "connected")) continue;
      onState({
        server: name,
        state,
        source: safeSource,
        observation: "native",
        message: `MCP ${name} (${safeSource}): native ${status}`,
        diagnostic:
          status === "failed"
            ? { code: "connection_failed" }
            : status === "needs-auth"
              ? { code: "auth_required" }
              : undefined,
      });
    }
  };
}

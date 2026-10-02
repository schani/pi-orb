import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { Result } from "neverthrow";
import type { OrbMcpState } from "../mcp/native.ts";

export interface McpStatusRecordError {
  readonly type: "mcp_status_record_error";
  readonly message: string;
}

export function recordMcpStatus(
  manager: Pick<SessionManager, "appendCustomEntry" | "getSessionId">,
  { server, state, diagnostic, sessionId }: OrbMcpState,
): Result<void, McpStatusRecordError> {
  return Result.fromThrowable(
    () =>
      manager.appendCustomEntry("pi-orb:mcp-status", {
        server,
        state,
        ...(sessionId !== undefined ? { sessionId } : {}),
        source: sessionId === undefined || sessionId === manager.getSessionId() ? "root" : "child",
        ...(diagnostic !== undefined ? { diagnostic } : {}),
        message:
          state === "connected"
            ? `MCP ${server}: connected.`
            : `MCP ${server}: ${state}. Check project MCP settings.`,
      }),
    () => ({
      type: "mcp_status_record_error" as const,
      message: "Cannot record MCP connection status",
    }),
  )().map(() => undefined);
}

import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { Result } from "neverthrow";

export interface McpAdoptionError {
  readonly type: "mcp_adoption_error";
  readonly message: string;
}

export function recordMcpAdoption(
  manager: Pick<SessionManager, "getEntries" | "appendCustomEntry">,
  data: { revision: number; servers: string[]; secretRevision: number },
): Result<void, McpAdoptionError> {
  return Result.fromThrowable(
    () => {
      const previous = manager
        .getEntries()
        .findLast((entry) => entry.type === "custom" && entry.customType === "pi-orb:mcp-config");
      if (
        (data.servers.length > 0 || previous) &&
        (previous?.type !== "custom" || JSON.stringify(previous.data) !== JSON.stringify(data))
      )
        manager.appendCustomEntry("pi-orb:mcp-config", data);
    },
    () => ({
      type: "mcp_adoption_error" as const,
      message: "Cannot record MCP configuration adoption",
    }),
  )();
}

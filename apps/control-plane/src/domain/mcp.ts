import type { McpCatalog } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import type { ResultAsync } from "neverthrow";

export interface McpConfigError {
  readonly type: "mcp_config_error";
  readonly code: "not_found" | "conflict" | "unavailable";
  readonly message: string;
}
export interface McpStore {
  read(task: SimulationTask, projectId: string): ResultAsync<McpCatalog, McpConfigError>;
  replace(
    task: SimulationTask,
    projectId: string,
    catalog: McpCatalog,
  ): ResultAsync<McpCatalog, McpConfigError>;
}

import type { Context } from "@earendil-works/chord";
import type { ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import type { ResultAsync } from "neverthrow";
import type { ToolError } from "./catalog.ts";
/** Scoped immutable resources and private artifacts; never an arbitrary control-plane filesystem. */
export interface AgentToolFiles {
  read?(
    request: { path: string; offset?: number; limit?: number },
    api: ToolExecutionApi,
    context: Context,
  ): ResultAsync<ToolExecutionResult | undefined, ToolError>;
  spill?(text: string, api: ToolExecutionApi, context: Context): ResultAsync<string, ToolError>;
}

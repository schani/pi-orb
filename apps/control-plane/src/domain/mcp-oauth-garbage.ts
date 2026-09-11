import type { SimulationTask } from "determined";
import { err, ok, type Result } from "neverthrow";
import { sleepResult } from "./dst.ts";
import { logEvent } from "./log.ts";
import { MCP_OAUTH_SECRETS, type McpOAuthError } from "./mcp-oauth.ts";
import type { CredentialSecretStore } from "./ports.ts";

export interface McpOAuthGarbageStore {
  pending(task: SimulationTask): Promise<Result<string[], McpOAuthError>>;
  finish(
    task: SimulationTask,
    version: string,
    destroyed: boolean,
  ): Promise<Result<void, McpOAuthError>>;
}
/** Durable exact-version cleanup. Concurrent collectors may destroy the same retired version safely. */
export async function collectMcpOAuthGarbage(
  task: SimulationTask,
  store: McpOAuthGarbageStore,
  secrets: CredentialSecretStore,
  signal?: AbortSignal,
) {
  const pending = await store.pending(task);
  if (pending.isErr()) return err(pending.error);
  for (const version of pending.value) {
    if (signal?.aborted) return ok(undefined);
    await task.checkpoint("mcp:destroy-retired-secret");
    const removed = await secrets.destroySecret(task, MCP_OAUTH_SECRETS, version);
    const recorded = await store.finish(task, version, removed.isOk());
    if (recorded.isErr()) return err(recorded.error);
  }
  return ok(undefined);
}
export async function mcpOAuthCleanupLoop(
  task: SimulationTask,
  store: McpOAuthGarbageStore,
  secrets: CredentialSecretStore,
  signal: AbortSignal,
) {
  let unavailable = false;
  while (!signal.aborted) {
    const result = await collectMcpOAuthGarbage(task, store, secrets, signal);
    if (result.isErr() !== unavailable) {
      unavailable = result.isErr();
      logEvent(
        task,
        unavailable ? "mcp-credential-cleanup-unavailable" : "mcp-credential-cleanup-recovered",
      );
    }
    await sleepResult(task, 300_000, "MCP retired credential cleanup", signal);
  }
}

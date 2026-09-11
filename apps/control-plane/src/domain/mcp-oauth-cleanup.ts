import type { SimulationTask } from "determined";
import { err, ok } from "neverthrow";
import { MCP_OAUTH_SECRETS, oauthError, type StoredMcpOAuth } from "./mcp-oauth.ts";
import type { CredentialSecretStore } from "./ports.ts";

/** Called after the project deletion fence/quarantine; includes unreferenced crash residue. */
export async function deleteProjectMcpOAuth(
  task: SimulationTask,
  secrets: CredentialSecretStore,
  projectId: string,
) {
  const listed = await secrets.listSecretVersions(task, MCP_OAUTH_SECRETS);
  if (listed.isErr()) return err(oauthError("unavailable"));
  for (const version of listed.value) {
    const read = await secrets.readSecret<StoredMcpOAuth>(task, MCP_OAUTH_SECRETS, version);
    if (read.isErr()) return err(oauthError("unavailable"));
    if (!read.value || read.value.projectId !== projectId) continue;
    const destroyed = await secrets.destroySecret(task, MCP_OAUTH_SECRETS, version);
    if (destroyed.isErr()) return err(oauthError("unavailable"));
  }
  return ok(undefined);
}

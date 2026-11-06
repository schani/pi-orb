import type { McpCatalog, McpConfig, ProjectMcpStatus } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, type Result, type ResultAsync } from "neverthrow";
import type { McpOAuth } from "./mcp-oauth.ts";
import type { ControlPlaneStore, ProjectSecretsDeps } from "./ports.ts";
import { getProjectSecretSnapshot } from "./project-secrets.ts";

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

export interface McpProbeError {
  readonly type: "mcp_probe_error";
  readonly diagnostic: "invalid_binding" | "auth_required" | "connection_failed";
}
export interface McpHealthDeps {
  store: Pick<ControlPlaneStore, "getProject">;
  catalog: Pick<McpStore, "read">;
  projectSecrets: ProjectSecretsDeps;
  oauth: Pick<McpOAuth, "token">;
  probe: (
    config: McpConfig,
    secrets: Readonly<Record<string, string>>,
    accessToken?: string,
  ) => Promise<Result<void, McpProbeError>>;
}

export async function readProjectMcpStatus(
  task: SimulationTask,
  deps: McpHealthDeps,
  projectId: string,
  ownerUserId: string,
): Promise<Result<ProjectMcpStatus, McpConfigError>> {
  const project = await deps.store.getProject(task, projectId);
  if (project.isErr())
    return err({
      type: "mcp_config_error",
      code: "unavailable",
      message: "MCP status unavailable",
    });
  if (!project.value || project.value.ownerUserId !== ownerUserId)
    return err({
      type: "mcp_config_error",
      code: "not_found",
      message: "Project doesn't exist",
    });
  const catalog = await deps.catalog.read(task, projectId);
  if (catalog.isErr()) return err(catalog.error);
  const needsSecrets = (config: McpConfig) =>
    Object.values(config.headers).some((binding) => "secret" in binding);
  const secrets = catalog.value.servers.some(needsSecrets)
    ? await getProjectSecretSnapshot(task, deps.projectSecrets, projectId)
    : ok({ values: {} });
  const servers = await Promise.all(
    catalog.value.servers.map(async (config): Promise<ProjectMcpStatus["servers"][number]> => {
      const unknown = {
        name: config.name,
        status: "unknown",
        diagnostic: "credentials_unavailable",
      } as const;
      if (needsSecrets(config) && secrets.isErr()) return unknown;
      let accessToken: string | undefined;
      if (config.oauth) {
        const grant = await deps.oauth.token(
          task,
          {
            projectId,
            id: config.oauth.id,
            url: config.url,
          },
          { reason: "startup" },
        );
        if (grant.isErr())
          return grant.error.code === "auth_required"
            ? { name: config.name, status: "needs-auth", diagnostic: "auth_required" }
            : unknown;
        accessToken = grant.value.accessToken;
      }
      const result = await deps.probe(
        config,
        secrets.isOk() ? secrets.value.values : {},
        accessToken,
      );
      return result.isOk()
        ? { name: config.name, status: "available" }
        : {
            name: config.name,
            status:
              result.error.diagnostic === "auth_required"
                ? "needs-auth"
                : result.error.diagnostic === "invalid_binding"
                  ? "unknown"
                  : "unavailable",
            diagnostic: result.error.diagnostic,
          };
    }),
  );
  return ok({ revision: catalog.value.revision, servers });
}

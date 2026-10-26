import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { err, ok, type Result, type ResultAsync } from "neverthrow";
import type { StoreError } from "../domain/errors.ts";
import type { GitIdentityStore } from "../domain/git-identity.ts";
import type { HostingStore } from "../domain/hosting-ports.ts";
import type { UserStore } from "../domain/identity.ts";
import type { McpStore } from "../domain/mcp.ts";
import type { McpOAuthStore } from "../domain/mcp-oauth.ts";
import type { ModelUsageLedger } from "../domain/model-usage.ts";
import type { OwnerSkillStore } from "../domain/owner-skills.ts";
import type { PersonalInstructionsStore } from "../domain/personal-instructions.ts";
import type {
  ControlPlaneStore,
  CredentialPointerStoreFactory,
  OwnerSecretsDeps,
  ProjectSecretPointerStore,
  SigningKeyStore,
} from "../domain/ports.ts";
import type { ProjectInstructionsStore } from "../domain/project-instructions.ts";
import type { ResourceSource } from "../domain/resources.ts";
import type { AgentPersistence } from "./durable/persistence.ts";
import { PgAgentPersistence } from "./durable/pg-persistence.ts";
import { PgClient, type PostgreSQLClient } from "./pg/client.ts";
import { PostgreSQLCredentialPointerStore } from "./pg/credential-pointers.ts";
import { PostgreSQLGitIdentityStore } from "./pg/git-identity.ts";
import { PostgreSQLHostingStore } from "./pg/hosting.ts";
import { PostgreSQLMcpStore } from "./pg/mcp.ts";
import { PostgreSQLMcpOAuthStore } from "./pg/mcp-oauth.ts";
import { type MigrationOptions, runMigrations } from "./pg/migrate.ts";
import { PostgreSQLModelUsageLedger } from "./pg/model-usage.ts";
import { PostgreSQLOwnerSkillStore } from "./pg/owner-skills.ts";
import { PostgreSQLPersonalInstructionsStore } from "./pg/personal-instructions.ts";
import { PGliteClient } from "./pg/pglite-client.ts";
import { PostgreSQLProjectInstructionsStore } from "./pg/project-instructions.ts";
import { PostgreSQLProjectSecretPointerStore } from "./pg/project-secrets.ts";
import { PgResourceGate } from "./pg/resource-gate.ts";
import { PostgreSQLSigningKeyStore } from "./pg/signing-keys.ts";
import { PostgreSQLControlPlaneStore } from "./pg/store.ts";
import { PostgreSQLUserSecretPointerStore } from "./pg/user-secrets.ts";
import { PostgreSQLUserStore } from "./pg/users.ts";

export interface ControlPlaneDatabase {
  readonly store: ControlPlaneStore;
  readonly agentPersistence: AgentPersistence;
  resourceGate(source: ResourceSource): PgResourceGate;
  readonly pointers: CredentialPointerStoreFactory;
  readonly projectSecrets: ProjectSecretPointerStore;
  readonly ownerSecrets: OwnerSecretsDeps["pointers"];
  readonly ownerSkills: OwnerSkillStore;
  readonly personalInstructions: PersonalInstructionsStore;
  readonly gitIdentity: GitIdentityStore;
  readonly projectInstructions: ProjectInstructionsStore;
  readonly signingKeys: SigningKeyStore;
  readonly hosting: HostingStore;
  readonly mcp: McpStore;
  readonly mcpOAuth: McpOAuthStore & import("../domain/mcp-oauth-garbage.ts").McpOAuthGarbageStore;
  readonly users: UserStore;
  readonly modelUsage: ModelUsageLedger & import("../domain/usage-read.ts").ModelUsageReader;
  migrate(options?: MigrationOptions): ResultAsync<string[], StoreError>;
  close(): ResultAsync<void, StoreError>;
}

export type DatabaseOptions =
  | { readonly kind: "postgresql"; readonly connectionString: string }
  | { readonly kind: "pglite"; readonly path?: string };

/** Compose the stores over an already-built client (also the test seam for a raw client). */
export function composeControlPlaneDatabase(client: PostgreSQLClient): ControlPlaneDatabase {
  const store = new PostgreSQLControlPlaneStore(client);
  const agentPersistence = new PgAgentPersistence(client, store);
  const modelUsage = new PostgreSQLModelUsageLedger(client);
  return {
    store,
    agentPersistence,
    resourceGate: (source) => new PgResourceGate(client, source),
    pointers: new PostgreSQLCredentialPointerStore(client),
    projectSecrets: new PostgreSQLProjectSecretPointerStore(client),
    ownerSecrets: new PostgreSQLUserSecretPointerStore(client),
    ownerSkills: new PostgreSQLOwnerSkillStore(client),
    personalInstructions: new PostgreSQLPersonalInstructionsStore(client),
    gitIdentity: new PostgreSQLGitIdentityStore(client),
    projectInstructions: new PostgreSQLProjectInstructionsStore(client),
    signingKeys: new PostgreSQLSigningKeyStore(client),
    hosting: new PostgreSQLHostingStore(client),
    mcp: new PostgreSQLMcpStore(client),
    mcpOAuth: new PostgreSQLMcpOAuthStore(client),
    users: new PostgreSQLUserStore(client),
    modelUsage,
    migrate: (options) => runMigrations(client, options),
    close: () =>
      modelUsage
        .drain()
        .andThen(() => agentPersistence.close())
        .mapErr(
          (error): StoreError => ({
            type: "store_error",
            code: "unavailable",
            message: error.message,
            retryable: error.retryable,
          }),
        )
        .andThen(() => client.end()),
  };
}

export function openControlPlaneDatabase(
  options: DatabaseOptions,
): Result<ControlPlaneDatabase, StoreError> {
  try {
    if (options.kind === "postgresql")
      return ok(composeControlPlaneDatabase(new PgClient(options.connectionString)));
    if (options.path !== undefined)
      mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
    return ok(composeControlPlaneDatabase(new PGliteClient(options.path)));
  } catch (error) {
    return err({
      type: "store_error",
      code: "unavailable",
      message: `cannot initialize ${options.kind}: ${String(error)}`,
      retryable: false,
    });
  }
}

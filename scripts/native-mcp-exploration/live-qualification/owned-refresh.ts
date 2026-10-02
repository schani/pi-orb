import { pathToFileURL } from "node:url";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { NoSimulationTask } from "determined";
import { type Result, ResultAsync } from "neverthrow";
import {
  createMcpOAuthFetch,
  SdkMcpOAuth,
} from "../../../apps/control-plane/src/adapters/mcp-oauth.ts";
import { PgClient } from "../../../apps/control-plane/src/adapters/pg/client.ts";
import { PostgreSQLMcpOAuthStore } from "../../../apps/control-plane/src/adapters/pg/mcp-oauth.ts";
import { GsmSecretStore } from "../../../apps/control-plane/src/adapters/secrets/gsm-store.ts";
import {
  MCP_OAUTH_SECRETS,
  McpOAuth,
  type McpOAuthBinding,
  type McpOAuthRow,
  type StoredMcpOAuth,
} from "../../../apps/control-plane/src/domain/mcp-oauth.ts";
import type { CredentialSecretStore } from "../../../apps/control-plane/src/domain/ports.ts";
import { MAX_BYTES, observeTokenResponses, type ScopeMetric } from "./oauth-scope-measurement.mjs";

const projectId = "4661f85f-e70f-4ccd-b50d-2524496cb02a";
const GCP_PROJECT = "playground-dev-6ae7";
const DB_SECRET = "pi-orb-database-url";
const DB_VERSION = "2";
const CREDENTIAL_PREFIX = "pi-orb-credential";
const CALLBACK = "https://pi-orb-1077475695242.us-central1.run.app/api/v1/mcp/oauth/callback";
export const OWNED_BINDINGS = Object.freeze({
  CF: {
    projectId,
    id: "1cfa006b-da21-4c11-9b5b-95cd28a9bf1b",
    url: "https://mcp.cloudflare.com/mcp",
    endpoint: "https://mcp.cloudflare.com/token",
  },
  DD: {
    projectId,
    id: "c25b1857-1896-45cf-a427-a90cee36d125",
    url: "https://mcp.us5.datadoghq.com/v1/mcp",
    endpoint: "https://us5.datadoghq.com/api/v2/oauth2/token",
  },
});
type Service = keyof typeof OWNED_BINDINGS;
type ReadonlyStore = Pick<PostgreSQLMcpOAuthStore, "readReadonly">;
type TokenDomain = Pick<McpOAuth, "token">;
interface Dependencies {
  store: ReadonlyStore;
  secrets: Pick<CredentialSecretStore, "readSecret">;
  now: () => number;
  makeOAuth: (
    endpoint: string,
    record: (metric: ScopeMetric) => void,
  ) => Result<SdkMcpOAuth, { type: "invalid_configuration" }>;
  makeDomain: (oauth: SdkMcpOAuth) => TokenDomain;
}
const task = () => new NoSimulationTask("owned-refresh-qualification", false);
const rejected = (service: Service, reason: string) => ({ status: "rejected", service, reason });
const unavailable = (service: Service, reason: string) => ({
  status: "unavailable",
  service,
  reason,
});
const samePointer = (a: McpOAuthRow, b: McpOAuthRow | null) =>
  Boolean(
    b &&
      a.secretVersion === b.secretVersion &&
      a.generation === b.generation &&
      a.rowVersion === b.rowVersion,
  );
const safeMetric = (metric: ScopeMetric) => ({
  kind: metric.kind === "refresh_token" ? "refresh_token" : "unverified",
  outcome:
    (
      [
        "present",
        "omitted",
        "invalid",
        "invalid_response",
        "oauth_error",
        "http_error",
        "oversize",
        "unverified",
      ] as const
    ).find((v) => v === metric.outcome) ?? "unverified",
  ...(metric.outcome === "present"
    ? {
        knownScopes: Array.isArray(metric.knownScopes)
          ? metric.knownScopes.filter((name) => name === "mcp_all")
          : [],
        unknownCount:
          typeof metric.unknownCount === "number" &&
          Number.isSafeInteger(metric.unknownCount) &&
          metric.unknownCount >= 0 &&
          metric.unknownCount <= Math.floor(MAX_BYTES / 2)
            ? metric.unknownCount
            : null,
      }
    : metric.outcome === "invalid"
      ? {
          invalidReason:
            (["non_string", "empty", "invalid_syntax"] as const).find(
              (reason) => reason === metric.invalidReason,
            ) ?? "invalid_syntax",
          boundaryWhitespace: metric.boundaryWhitespace === true,
          nonSpaceWhitespace: metric.nonSpaceWhitespace === true,
          disallowedCharacter: metric.disallowedCharacter === true,
        }
      : {}),
});
function safeCredential(
  value: unknown,
  binding: McpOAuthBinding,
  endpoint: string,
): value is StoredMcpOAuth {
  if (!value || typeof value !== "object") return false;
  const c = value as Partial<StoredMcpOAuth>;
  const oauth = c.oauth;
  const metadata = oauth && typeof oauth === "object" ? oauth["metadata"] : null;
  return (
    c.projectId === binding.projectId &&
    c.connectionId === binding.id &&
    metadata !== null &&
    typeof metadata === "object" &&
    (metadata as Record<string, unknown>)["token_endpoint"] === endpoint &&
    typeof c.refresh === "string" &&
    c.refresh.length > 0 &&
    typeof c.expiresAt === "number" &&
    Number.isFinite(c.expiresAt)
  );
}

/** Preflight checks the exact binding twice; only the first-party broker can write under lease/CAS. */
async function inspect(service: Service, deps: Pick<Dependencies, "store" | "secrets">) {
  const { endpoint, ...binding } = OWNED_BINDINGS[service];
  const first = await deps.store.readReadonly(task(), binding);
  if (first.isErr()) return { failure: unavailable(service, "binding_read_failed") };
  const row = first.value;
  if (
    !row ||
    !/^[1-9][0-9]*$/.test(row.secretVersion ?? "") ||
    !Number.isSafeInteger(row.generation) ||
    row.generation < 1 ||
    !Number.isSafeInteger(row.rowVersion) ||
    row.attempt
  )
    return { failure: rejected(service, "pointer_unavailable") };
  const secretVersion = row.secretVersion;
  if (!secretVersion) return { failure: rejected(service, "pointer_unavailable") };
  const loaded = await deps.secrets.readSecret<StoredMcpOAuth>(
    task(),
    MCP_OAUTH_SECRETS,
    secretVersion,
  );
  if (loaded.isErr() || !loaded.value)
    return { failure: unavailable(service, "credential_read_failed") };
  if (!safeCredential(loaded.value, binding, endpoint))
    return { failure: rejected(service, "credential_mismatch") };
  const again = await deps.store.readReadonly(task(), binding);
  if (again.isErr()) return { failure: unavailable(service, "binding_recheck_failed") };
  if (!samePointer(row, again.value)) return { failure: rejected(service, "pointer_changed") };
  return { row, credential: loaded.value, binding, endpoint };
}
export async function qualifyOwnedRefreshPreflight(
  service: string,
  store: ReadonlyStore,
  secrets: Pick<CredentialSecretStore, "readSecret">,
  now: () => number = () => Date.now(),
) {
  if (!Object.hasOwn(OWNED_BINDINGS, service))
    return { status: "rejected", reason: "unknown_binding" };
  const checked = await inspect(service as Service, { store, secrets });
  return (
    checked.failure ?? {
      status: "ready",
      service,
      generation: checked.row?.generation,
      expiresAt: checked.credential?.expiresAt,
      observedAt: now(),
    }
  );
}
export async function runOwnedMode(
  service: string,
  mode: "--execute" | "--inspect",
  store: ReadonlyStore,
  secrets: Pick<CredentialSecretStore, "readSecret">,
  now: () => number,
  execute: () => ReturnType<typeof qualifyOwnedRefresh>,
) {
  const preflight = await qualifyOwnedRefreshPreflight(service, store, secrets, now);
  if (mode === "--inspect" || preflight.status !== "ready") return preflight;
  return execute();
}
export async function qualifyOwnedRefresh(service: string, deps: Dependencies) {
  if (!Object.hasOwn(OWNED_BINDINGS, service))
    return { status: "rejected", reason: "unknown_binding" };
  const owned = service as Service;
  const checked = await inspect(owned, deps);
  if (checked.failure) return checked.failure;
  const { row, credential, binding, endpoint } = checked;
  if (!row || !credential || !binding || !endpoint)
    return unavailable(owned, "binding_read_failed");
  const now = deps.now();
  if (row.refreshLeaseUntil > now)
    return { status: "skipped", service: owned, reason: "lease_held" };
  if (credential.expiresAt > now)
    return { status: "skipped", service: owned, reason: "not_expired" };
  const observer: ReturnType<typeof safeMetric>[] = [];
  const oauth = deps.makeOAuth(endpoint, (metric) => {
    if (observer.length < 2) observer.push(safeMetric(metric));
  });
  if (!oauth || oauth.isErr()) return unavailable(owned, "observer_unavailable");
  const result = await deps.makeDomain(oauth.value).token(task(), binding, { reason: "startup" });
  if (result.isErr())
    return { ...unavailable(owned, "token_failed"), generationBefore: row.generation, observer };
  const durable = await deps.store.readReadonly(task(), binding);
  if (
    durable.isErr() ||
    !durable.value ||
    durable.value.generation !== result.value.generation ||
    durable.value.generation <= row.generation ||
    durable.value.rowVersion <= row.rowVersion ||
    durable.value.secretVersion === row.secretVersion ||
    !durable.value.secretVersion ||
    durable.value.attempt
  )
    return {
      ...unavailable(owned, "publication_unverified"),
      generationBefore: row.generation,
      observer,
    };
  return {
    status: "refreshed",
    service: owned,
    generationBefore: row.generation,
    generationAfter: result.value.generation,
    durableGeneration: durable.value.generation,
    durableRowVersion: durable.value.rowVersion,
    published: true,
    scopeUnverified: !observer.some(
      (metric) => metric.kind === "refresh_token" && metric.outcome === "present",
    ),
    observer,
  };
}

export async function main(argv: string[]) {
  if (
    argv.length !== 7 ||
    argv[1] !== GCP_PROJECT ||
    argv[2] !== DB_SECRET ||
    argv[3] !== DB_VERSION ||
    argv[4] !== CREDENTIAL_PREFIX ||
    argv[5] !== CALLBACK ||
    (argv[6] !== "--execute" && argv[6] !== "--inspect") ||
    !Object.hasOwn(OWNED_BINDINGS, argv[0])
  )
    return { status: "invalid_input" };
  const service = argv[0] as Service;
  const read = await ResultAsync.fromPromise(
    new SecretManagerServiceClient().accessSecretVersion(
      {
        name: `projects/${GCP_PROJECT}/secrets/${DB_SECRET}/versions/${DB_VERSION}`,
      },
      { timeout: 5000 },
    ),
    () => "database_secret_unavailable",
  );
  if (read.isErr() || !read.value[0]?.payload?.data)
    return { status: "unavailable", reason: "database_secret_unavailable" };
  const dbUrl = Buffer.from(read.value[0].payload.data).toString("utf8");
  const readonlyDb = new PgClient(dbUrl, true);
  const secrets = new GsmSecretStore({ projectId: GCP_PROJECT, secretPrefix: CREDENTIAL_PREFIX });
  let readonlyClosed = false;
  try {
    return await runOwnedMode(
      service,
      argv[6] as "--execute" | "--inspect",
      new PostgreSQLMcpOAuthStore(readonlyDb),
      secrets,
      () => Date.now(),
      async () => {
        readonlyClosed = true;
        await readonlyDb.end();
        const db = new PgClient(dbUrl);
        const network = createMcpOAuthFetch();
        try {
          return await qualifyOwnedRefresh(service, {
            store: new PostgreSQLMcpOAuthStore(db),
            secrets,
            now: () => Date.now(),
            makeOAuth: (endpoint, record) =>
              observeTokenResponses(network.fetcher, {
                tokenEndpoint: endpoint,
                knownScopes: service === "DD" ? ["mcp_all"] : [],
                record,
              }).map((fetcher) => new SdkMcpOAuth(CALLBACK, fetcher)),
            makeDomain: (oauth) => new McpOAuth(new PostgreSQLMcpOAuthStore(db), secrets, oauth),
          });
        } finally {
          await network.close();
          await db.end();
        }
      },
    );
  } finally {
    if (!readonlyClosed) await readonlyDb.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (result.status !== "refreshed" && result.status !== "skipped" && result.status !== "ready")
        process.exitCode = 1;
    },
    () => {
      process.stdout.write('{"status":"unavailable"}\n');
      process.exitCode = 1;
    },
  );
}

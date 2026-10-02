import { ResultAsync } from "neverthrow";
import { fetchMcpCatalog } from "../../../apps/orb-runtime/src/mcp/boot.ts";
import { fetchProjectSecretSnapshotAtBoot } from "../../../apps/orb-runtime/src/project-secrets/endpoint.ts";
import { runQualification } from "./runner.ts";

export const fixtureProjectId = "4661f85f-e70f-4ccd-b50d-2524496cb02a";
const expected = {
  cloudflare: {
    description: "cloudflare MCP",
    url: "https://mcp.cloudflare.com/mcp",
    id: "1cfa006b-da21-4c11-9b5b-95cd28a9bf1b",
  },
  datadog: {
    description: "datadog MCP",
    url: "https://mcp.us5.datadoghq.com/v1/mcp",
    id: "c25b1857-1896-45cf-a427-a90cee36d125",
  },
} as const;
const calls = {
  cloudflare: {
    phase: "call",
    serverName: "cloudflare",
    toolName: "execute",
    argument: JSON.stringify({
      code: "async () => { const r = await cloudflare.request({ method: 'GET', path: '/accounts', query: { per_page: 1 } }); return { success: r.success, status: r.status, count: Array.isArray(r.result) ? r.result.length : 0 }; }",
    }),
  },
  datadog: {
    phase: "call",
    serverName: "datadog",
    toolName: "search_datadog_monitors",
    argument: JSON.stringify({
      max_tokens: 1000,
      query: "status:alert priority:p1",
      telemetry: { intent: "Qualify native MCP read-only monitor search" },
    }),
  },
} as const;
export const plan = (provider: string | undefined, mode?: string) =>
  !mode && (provider === "cloudflare" || provider === "datadog") ? calls[provider] : null;
export function fence(catalog: {
  revision: number;
  servers: readonly {
    name: string;
    description?: string;
    url: string;
    headers: Record<string, unknown>;
    oauth?: { id: string };
  }[];
}): boolean {
  return (
    catalog.revision === 1 &&
    catalog.servers.length === 2 &&
    new Set(catalog.servers.map((server) => server.name)).size === 2 &&
    catalog.servers.every((server) => {
      if (server.name !== "cloudflare" && server.name !== "datadog") return false;
      const match = expected[server.name];
      return (
        server.description === match.description &&
        server.url === match.url &&
        server.oauth?.id === match.id &&
        Object.keys(server.headers).length === 0
      );
    })
  );
}
export const fixtureBinding = (projectId: string, catalog: Parameters<typeof fence>[0]) =>
  projectId === fixtureProjectId && fence(catalog);
export function identity(
  metadata: Record<string, unknown>,
  expectedOrbId: string | undefined,
): boolean {
  return (
    !!expectedOrbId &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(expectedOrbId) &&
    metadata.PI_ORB_ID === expectedOrbId &&
    typeof metadata.PI_ORB_RUNTIME_TOKEN === "string" &&
    !!metadata.PI_ORB_RUNTIME_TOKEN &&
    typeof metadata.PI_ORB_CONTROL_PLANE_URL === "string" &&
    /^https:\/\//.test(metadata.PI_ORB_CONTROL_PLANE_URL)
  );
}
const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const label = (value: unknown, allowed: readonly string[]) =>
  typeof value === "string" && allowed.includes(value) ? value : undefined;
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const diagnosticCodes = [
  "broker_unavailable",
  "auth_required",
  "network",
  "upstream_http",
  "invalid_binding",
  "connection_failed",
];
const stateNames = ["failed", "needs-auth", "disconnected", "connected"];
const compact = (record: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
export function sanitize(record: Record<string, unknown>): Record<string, unknown> | null {
  const server = label(record.server, ["cloudflare", "datadog"]);
  if (record.phase === "discover")
    return { phase: "discover", server, count: number(record.count) };
  if (record.phase === "grant_before" || record.phase === "grant_after")
    return compact({
      phase: record.phase,
      server,
      status:
        number(record.generation) !== undefined
          ? "connected"
          : label(record.code, ["cancelled", "unavailable", "invalid", "auth_required"]),
      generation: number(record.generation),
    });
  if (record.phase === "connection_failure") {
    const diagnostic = object(record.diagnostic);
    return compact({
      phase: "connection_failure",
      server,
      state: label(record.state, [...stateNames, "unavailable"]),
      code: label(diagnostic.code, diagnosticCodes),
      httpStatus: number(diagnostic.httpStatus),
    });
  }
  if (record.phase === "call")
    return compact({
      phase: "read",
      server,
      status: label(record.status, ["ok", "error"]),
      contentCount: number(record.contentCount),
      ...(server === "cloudflare"
        ? {
            application: {
              apiSuccess: record.apiSuccess === true,
              apiStatus: number(record.apiStatus),
              count: number(record.count),
            },
          }
        : {
            application: compact({
              outcome: label(object(record.application).outcome, [
                "success",
                "error",
                "truncated",
                "unknown",
              ]),
              resultCount: number(object(record.application).resultCount),
              displayedItems: number(object(record.application).displayedItems),
              maxTokensHint:
                object(record.application).maxTokensHint === true
                  ? true
                  : object(record.application).maxTokensHint === false
                    ? false
                    : undefined,
            }),
          }),
    });
  if (record.phase === "states")
    return {
      phase: "states",
      states: (Array.isArray(record.events) ? record.events : []).map((item: unknown) => {
        const event = object(item);
        return compact({
          server: label(event.server, ["cloudflare", "datadog"]),
          state: label(event.state, stateNames),
          code: label(object(event.diagnostic).code, diagnosticCodes),
        });
      }),
    };
  return null;
}
const output = (record: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify(record)}\n`);
const fail = (stage: string, code: string) => ({ stage, code });
async function main() {
  const selected = process.argv.length === 3 ? plan(process.argv[2]) : null;
  if (!selected || !process.env.EXPECTED_ORB_ID)
    return fail("guard", "invalid_selection_or_orb_id");
  const metadata = await ResultAsync.fromThrowable(
    () =>
      fetch(
        "http://metadata.google.internal/computeMetadata/v1/instance/attributes/pi-orb-config",
        { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(10_000) },
      ).then(async (response) => (response.ok ? response.json() : null)),
    () => fail("identity", "metadata_unavailable"),
  )();
  const config = object(metadata.isOk() ? metadata.value : null);
  if (metadata.isErr() || !identity(config, process.env.EXPECTED_ORB_ID))
    return fail("identity", "unexpected_orb");
  const broker = {
    controlPlaneUrl: config.PI_ORB_CONTROL_PLANE_URL as string,
    runtimeToken: config.PI_ORB_RUNTIME_TOKEN as string,
  };
  const catalog = await fetchMcpCatalog(broker);
  if (catalog.isErr() || !fence(catalog.value)) return fail("catalog", "unexpected_catalog");
  const snapshot = await fetchProjectSecretSnapshotAtBoot(broker);
  if (snapshot.isErr()) return fail("binding", "snapshot_unavailable");
  if (Object.keys(snapshot.value.values).length !== 0) return fail("binding", "unexpected_secrets");
  let verified = false;
  const result = await runQualification({
    catalog: catalog.value,
    broker,
    secrets: {},
    ...selected,
    output: (record) => {
      const projected = sanitize(record);
      if (projected) {
        output(projected);
        if (record.phase === "call" && record.server === selected.serverName)
          verified =
            record.status === "ok" &&
            (selected.serverName === "cloudflare"
              ? record.apiSuccess === true && record.apiStatus === 200
              : object(record.application).outcome === "success");
      }
    },
  });
  return result.isErr()
    ? fail(result.error.phase, result.error.code)
    : verified
      ? null
      : fail("read", "application_unverified");
}
if (process.argv[1]?.endsWith("/iap-read.mjs"))
  void main()
    .then((error) => {
      if (error) {
        output({ phase: "error", ...error });
        process.exitCode = 1;
      }
    })
    .catch(() => {
      output({ phase: "error", stage: "driver", code: "unexpected_failure" });
      process.exitCode = 1;
    });

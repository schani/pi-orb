import { ResultAsync } from "neverthrow";
import { fetchMcpCatalog } from "../../../apps/orb-runtime/src/mcp/boot.ts";
import { identity, sanitize as sanitizeIap } from "./iap-read.ts";
import { runQualification } from "./runner.ts";

export { identity };

export const fixtureProjectId = "35f581fb-7bbf-4542-a1e8-0d047657a71d";
const expected = {
  cloudflare: {
    description: "cloudflare MCP",
    url: "https://mcp.cloudflare.com/mcp",
    id: "406a3aeb-7e46-492e-b56a-07364453d511",
  },
  datadog: {
    description: "datadog MCP",
    url: "https://mcp.us5.datadoghq.com/v1/mcp",
    id: "e2c2ee5c-0fc9-4133-8f41-d333ed5e46c9",
  },
} as const;
type Catalog = {
  revision: number;
  servers: readonly {
    name: string;
    description?: string;
    url: string;
    headers: Record<string, unknown>;
    oauth?: { id: string };
  }[];
};
export function fixtureBinding(projectId: string, catalog: Catalog) {
  if (projectId !== fixtureProjectId || catalog?.revision !== 3 || catalog.servers?.length !== 3)
    return null;
  const names = catalog.servers.map((server) => server.name);
  if (
    new Set(names).size !== 3 ||
    !["cloudflare", "datadog", "posthog"].every((name) => names.includes(name))
  )
    return null;
  const posthog = catalog.servers.find((server) => server.name === "posthog")!;
  if (posthog.url !== "https://mcp.posthog.com/mcp" || posthog.oauth || !posthog.headers)
    return null;
  const selected = catalog.servers.filter((server) => server.name !== "posthog");
  if (
    !selected.every((server) => {
      const match = expected[server.name as keyof typeof expected];
      return (
        match &&
        server.description === match.description &&
        server.url === match.url &&
        server.oauth?.id === match.id &&
        server.headers &&
        Object.keys(server.headers).length === 0
      );
    })
  )
    return null;
  return { revision: 3, servers: selected };
}
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
export function qualificationInput(
  projectId: string,
  catalog: Catalog,
  provider: string,
  mode?: string,
) {
  const selected = fixtureBinding(projectId, catalog);
  if (!selected || mode || (provider !== "cloudflare" && provider !== "datadog")) return null;
  return { catalog: selected, ...calls[provider] };
}
export const sanitize = sanitizeIap;
export function verifiedRead(provider: string, record: Record<string, unknown>) {
  if (record.phase !== "call" || record.server !== provider || record.status !== "ok") return false;
  return provider === "cloudflare"
    ? record.apiSuccess === true &&
        record.apiStatus === 200 &&
        typeof record.count === "number" &&
        Number.isInteger(record.count) &&
        record.count > 0
    : provider === "datadog" &&
        record.application !== null &&
        typeof record.application === "object" &&
        (record.application as { outcome?: unknown }).outcome === "success";
}
const output = (record: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify(record)}\n`);
const fail = (stage: string, code: string) => ({ stage, code });
async function main() {
  const provider = process.argv.length === 3 ? process.argv[2] : undefined;
  if (
    !provider ||
    !process.env.EXPECTED_ORB_ID ||
    (provider !== "cloudflare" && provider !== "datadog")
  )
    return fail("guard", "invalid_selection_or_orb_id");
  const metadata = await ResultAsync.fromThrowable(
    () =>
      fetch(
        "http://metadata.google.internal/computeMetadata/v1/instance/attributes/pi-orb-config",
        {
          headers: { "Metadata-Flavor": "Google" },
          signal: AbortSignal.timeout(10_000),
        },
      ).then(async (response) => (response.ok ? response.json() : null)),
    () => fail("identity", "metadata_unavailable"),
  )();
  const config =
    metadata.isOk() && metadata.value && typeof metadata.value === "object" ? metadata.value : {};
  if (metadata.isErr() || !identity(config, process.env.EXPECTED_ORB_ID))
    return fail("identity", "unexpected_orb");
  const broker = {
    controlPlaneUrl: config.PI_ORB_CONTROL_PLANE_URL as string,
    runtimeToken: config.PI_ORB_RUNTIME_TOKEN as string,
  };
  const catalog = await fetchMcpCatalog(broker);
  if (catalog.isErr()) return fail("catalog", "catalog_unavailable");
  const selected = qualificationInput(fixtureProjectId, catalog.value, provider);
  if (!selected) return fail("catalog", "unexpected_catalog");
  let verified = false;
  const result = await runQualification({
    ...selected,
    broker,
    secrets: {},
    exactReviewed: { [provider]: { [selected.toolName]: JSON.parse(selected.argument) } },
    output: (record) => {
      const projected = sanitize(record);
      if (projected) output(projected);
      if (verifiedRead(provider, record)) verified = true;
    },
  });
  return result.isErr()
    ? fail(result.error.phase, result.error.code)
    : verified
      ? null
      : fail("read", "application_unverified");
}
if (process.argv[1]?.endsWith("/glideos-read.mjs"))
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

import { lookup } from "node:dns";
import { isIP } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { McpConfig } from "@pi-orb/protocol";
import ipaddr from "ipaddr.js";
import { err, ok, Result, ResultAsync, type Result as TypedResult } from "neverthrow";
import { Agent } from "undici";
import type { McpProbeError } from "../domain/mcp.ts";

export function isPublicMcpAddress(address: string): boolean {
  const parsed = Result.fromThrowable(
    () => ipaddr.process(address).range(),
    () => "invalid",
  )();
  return parsed.isOk() && parsed.value === "unicast";
}
export function validateMcpEndpoint(value: string): TypedResult<URL, string> {
  const parsed = Result.fromThrowable(
    () => new URL(value),
    () => "Invalid MCP URL",
  )();
  if (parsed.isErr()) return parsed;
  const url = parsed.value;
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    (isIP(hostname) && !isPublicMcpAddress(hostname))
  )
    return err("MCP endpoint must be public HTTPS without credentials or a fragment");
  return ok(url);
}

/** DNS is checked inside the socket lookup, not in a rebinding-prone preflight. */
async function runProbe(
  config: McpConfig,
  secrets: Readonly<Record<string, string>>,
  listTools: boolean,
  accessToken?: string,
): Promise<TypedResult<{ description: string }, McpProbeError & { message: string }>> {
  const invalid = (message: string) =>
    ({ type: "mcp_probe_error", diagnostic: "invalid_binding", message }) as const;
  const endpoint = validateMcpEndpoint(config.url);
  if (endpoint.isErr()) return err(invalid(endpoint.error));
  const headers: Record<string, string> = {};
  for (const [name, binding] of Object.entries(config.headers)) {
    const value =
      "secret" in binding
        ? Object.hasOwn(secrets, binding.secret)
          ? secrets[binding.secret]
          : undefined
        : binding.literal;
    if (!value || /[\r\n]/.test(value))
      return err(invalid("Missing or invalid project secret/header binding"));
    headers[name] = "secret" in binding ? (binding.prefix ?? "") + value : value;
  }
  if (accessToken !== undefined) {
    if (!accessToken || /[\r\n]/.test(accessToken)) return err(invalid("Invalid OAuth token"));
    headers["Authorization"] = `Bearer ${accessToken}`;
  }
  const deadline = AbortSignal.timeout(10_000);
  let authRequired = false;
  let invalidAddress = false;
  const agent = new Agent({
    connect: {
      lookup: (hostname, options, callback) => {
        lookup(hostname, { all: true }, (error, addresses) => {
          // Node's lookup contract requires Error here; it never escapes the SDK adapter.
          if (
            error ||
            addresses.length === 0 ||
            addresses.some((a) => !isPublicMcpAddress(a.address))
          ) {
            invalidAddress = !error;
            callback(new Error("MCP endpoint DNS rejected"), "", 4);
            return;
          }
          if (options.all) callback(null, addresses);
          else {
            const first = addresses[0];
            if (first) callback(null, first.address, first.family);
          }
        });
      },
    },
  });
  const client = new Client(
    { name: "pi-orb", version: "1" },
    {
      capabilities: {},
      versionNegotiation: { mode: "auto" },
    },
  );
  const transport = new StreamableHTTPClientTransport(endpoint.value, {
    requestInit: { headers, redirect: "error" },
    fetch: async (url, options) => {
      const response = await fetch(url, {
        ...options,
        redirect: "error",
        dispatcher: agent,
        signal: AbortSignal.any([...(options?.signal ? [options.signal] : []), deadline]),
      } as RequestInit & { dispatcher: Agent });
      if (response.status === 401) authRequired = true;
      return response;
    },
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 0,
      maxReconnectionDelay: 0,
      reconnectionDelayGrowFactor: 1,
    },
  });
  const result = await ResultAsync.fromThrowable(
    async () => {
      await client.connect(transport, { signal: deadline, timeout: 10_000 });
      if (listTools && client.getServerCapabilities()?.tools)
        await client.listTools(undefined, { signal: deadline, timeout: 10_000 });
    },
    () => ({
      type: "mcp_probe_error" as const,
      diagnostic: invalidAddress
        ? ("invalid_binding" as const)
        : authRequired
          ? ("auth_required" as const)
          : ("connection_failed" as const),
      message: "Cannot connect to MCP; check endpoint and project secret bindings",
    }),
  )();
  const description = result.isOk()
    ? (client.getServerVersion()?.description ?? "").replace(/[\r\n]/g, " ").slice(0, 240)
    : "";
  await ResultAsync.fromThrowable(
    () => client.close(),
    () => "MCP probe cleanup failed",
  )();
  await ResultAsync.fromThrowable(
    () => agent.destroy(),
    () => "MCP probe cleanup failed",
  )();
  return result.isErr() ? err(result.error) : ok({ description });
}

export async function probeMcp(
  config: McpConfig,
  secrets: Readonly<Record<string, string>>,
): Promise<TypedResult<{ description: string }, string>> {
  return (await runProbe(config, secrets, false)).mapErr((error) => error.message);
}

export async function checkMcp(
  config: McpConfig,
  secrets: Readonly<Record<string, string>>,
  accessToken?: string,
): Promise<TypedResult<void, McpProbeError>> {
  return (await runProbe(config, secrets, true, accessToken))
    .map(() => undefined)
    .mapErr(({ type, diagnostic }) => ({ type, diagnostic }));
}

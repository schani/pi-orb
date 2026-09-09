import { lookup } from "node:dns";
import { isIP } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { McpConfig } from "@pi-orb/protocol";
import ipaddr from "ipaddr.js";
import { err, ok, Result, ResultAsync, type Result as TypedResult } from "neverthrow";
import { Agent } from "undici";

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
export async function probeMcp(
  config: McpConfig,
  secrets: Readonly<Record<string, string>>,
): Promise<TypedResult<{ description: string }, string>> {
  const endpoint = validateMcpEndpoint(config.url);
  if (endpoint.isErr()) return err(endpoint.error);
  const headers: Record<string, string> = {};
  for (const [name, binding] of Object.entries(config.headers)) {
    const value =
      "secret" in binding
        ? Object.hasOwn(secrets, binding.secret)
          ? secrets[binding.secret]
          : undefined
        : binding.literal;
    if (!value || /[\r\n]/.test(value))
      return err("Missing or invalid project secret/header binding");
    headers[name] = "secret" in binding ? (binding.prefix ?? "") + value : value;
  }
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
    { capabilities: {}, versionNegotiation: { mode: "auto" } },
  );
  const transport = new StreamableHTTPClientTransport(endpoint.value, {
    requestInit: { headers, redirect: "error" },
    fetch: (url, options) =>
      fetch(url, {
        ...options,
        redirect: "error",
        dispatcher: agent,
        signal: AbortSignal.any([
          ...(options?.signal ? [options.signal] : []),
          AbortSignal.timeout(10_000),
        ]),
      } as RequestInit & { dispatcher: Agent }),
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 0,
      maxReconnectionDelay: 0,
      reconnectionDelayGrowFactor: 1,
    },
  });
  const result = await ResultAsync.fromPromise(
    client.connect(transport, { signal: AbortSignal.timeout(10_000), timeout: 10_000 }),
    () => "Cannot connect to MCP; check endpoint and project secret bindings",
  );
  const description = result.isOk()
    ? (client.getServerVersion()?.description ?? "").replace(/[\r\n]/g, " ").slice(0, 240)
    : "";
  await ResultAsync.fromPromise(client.close(), () => "MCP probe cleanup failed");
  await ResultAsync.fromPromise(agent.close(), () => "MCP probe cleanup failed");
  return result.isErr() ? err(result.error) : ok({ description });
}

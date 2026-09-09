import {
  MCP_RUNTIME_PATH,
  type McpCatalog,
  McpCatalogSchema,
  type McpConfig,
} from "@pi-orb/protocol";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import { Check } from "typebox/value";
import type { BrokerEnv } from "../broker/endpoint.ts";
import { type McpError, mcpError } from "./service.ts";

export function resolveMcpHeaders(
  config: McpConfig,
  secrets: Readonly<Record<string, string>>,
): Result<Record<string, string>, McpError> {
  const headers: Record<string, string> = {};
  for (const [name, binding] of Object.entries(config.headers)) {
    const value =
      "secret" in binding
        ? Object.hasOwn(secrets, binding.secret)
          ? secrets[binding.secret]
          : undefined
        : binding.literal;
    if (!value || /[\r\n]/.test(value))
      return err(
        mcpError("invalid", `MCP ${config.name}: missing or invalid secret/header binding`),
      );
    headers[name] = "secret" in binding ? (binding.prefix ?? "") + value : value;
  }
  return ok(headers);
}
export async function fetchMcpCatalog(env: BrokerEnv): Promise<Result<McpCatalog, McpError>> {
  const result = await ResultAsync.fromPromise(
    fetch(`${env.controlPlaneUrl}${MCP_RUNTIME_PATH}`, {
      headers: { Authorization: `Bearer ${env.runtimeToken}` },
      signal: AbortSignal.timeout(10_000),
    }).then(async (response) => (response.ok ? (response.json() as Promise<unknown>) : null)),
    () => mcpError("unavailable", "MCP configuration unavailable"),
  );
  if (result.isErr()) return err(result.error);
  return Check(McpCatalogSchema, result.value)
    ? ok(result.value)
    : err(mcpError("unavailable", "MCP configuration unavailable or invalid"));
}

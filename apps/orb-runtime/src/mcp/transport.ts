import type { McpConfig } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, Result, ResultAsync, type Result as TypedResult } from "neverthrow";
import { type McpError, mcpError } from "./error.ts";
import type { McpAccessGrant, McpCredentialResolver } from "./oauth.ts";

export interface OrbMcpDiagnostic {
  code:
    | "broker_unavailable"
    | "auth_required"
    | "network"
    | "upstream_http"
    | "invalid_binding"
    | "connection_failed";
  httpStatus?: number;
}

export interface OrbMcpState {
  server: string;
  state: "failed" | "needs-auth" | "disconnected" | "connected";
  message?: string;
  diagnostic?: OrbMcpDiagnostic | undefined;
}

/** The platform fetch boundary never forwards upstream error bodies, URLs, or redirect credentials. */
export function createBrokerMcpFetch(options: {
  config: McpConfig;
  headers: Record<string, string>;
  resolver?: McpCredentialResolver | undefined;
  task: SimulationTask;
  fetcher?: typeof fetch;
  onDiagnostic?: (diagnostic: OrbMcpDiagnostic | undefined) => void;
}): typeof fetch {
  const { config, headers, resolver, task, fetcher = fetch } = options;
  const report = (diagnostic: OrbMcpDiagnostic | undefined) => {
    const reported = Result.fromThrowable(
      () => options.onDiagnostic?.(diagnostic),
      () => mcpError("unavailable", "MCP diagnostic telemetry unavailable"),
    )();
    if (reported.isErr()) console.error(reported.error.message);
  };
  return async (input, init) => {
    const signal = init?.signal ?? new AbortController().signal;
    if (signal.aborted) {
      // biome-ignore lint/plugin/no-throw: MCP SDK fetch requires a rejected promise on cancellation.
      throw new Error("MCP request cancelled");
    }
    const requested = resolver
      ? await ResultAsync.fromPromise(resolver.resolve(task, signal), () =>
          mcpError("unavailable", "MCP token unavailable; check project MCP settings"),
        )
      : ok(ok(undefined));
    const credential: TypedResult<McpAccessGrant | undefined, McpError> = requested.isErr()
      ? err(requested.error)
      : requested.value;
    if (credential.isErr()) {
      report({
        code: credential.error.code === "auth_required" ? "auth_required" : "broker_unavailable",
      });
      // biome-ignore lint/plugin/no-throw: MCP SDK fetch requires a rejected promise on broker failure.
      throw new Error(credential.error.message);
    }
    if (signal.aborted) {
      // biome-ignore lint/plugin/no-throw: MCP SDK fetch requires a rejected promise on cancellation.
      throw new Error("MCP request cancelled");
    }
    const grant = credential.value;
    const built = Result.fromThrowable(
      () => {
        const requestHeaders = new Headers(init?.headers);
        for (const [name, value] of Object.entries(headers)) requestHeaders.set(name, value);
        if (grant) requestHeaders.set("Authorization", `Bearer ${grant.accessToken}`);
        return requestHeaders;
      },
      () => mcpError("invalid", `MCP ${config.name} request headers invalid`),
    )();
    if (built.isErr()) {
      report({ code: "invalid_binding" });
      // biome-ignore lint/plugin/no-throw: MCP SDK fetch requires a rejected promise on invalid headers.
      throw new Error(built.error.message);
    }
    const response = await ResultAsync.fromThrowable(
      () => fetcher(input, { ...init, headers: built.value, signal, redirect: "error" }),
      () => mcpError("unavailable", `MCP ${config.name} upstream unavailable`),
    )();
    if (response.isErr()) {
      report({ code: "network" });
      // biome-ignore lint/plugin/no-throw: MCP SDK fetch requires a rejected promise on network failure.
      throw new Error(response.error.message);
    }
    if (response.value.status === 401 && grant) resolver?.rejected(grant.generation);
    if (response.value.ok) {
      resolver?.accepted();
      report(undefined);
      return response.value;
    }
    const status = response.value.status;
    if (
      !(status === 405 && init?.method === "GET") &&
      !(status === 404 && init?.method === "DELETE")
    )
      report({ code: "upstream_http", httpStatus: status });
    await ResultAsync.fromThrowable(
      async () => {
        await response.value.body?.cancel();
      },
      () => mcpError("unavailable", "MCP response cleanup failed"),
    )();
    // Keep the challenge for the MCP SDK; the remote body is discarded.
    const challenge = response.value.headers.get("www-authenticate");
    return new Response("MCP upstream request failed", {
      status: status === 304 || status < 200 ? 502 : status,
      headers: {
        "content-type": "text/plain",
        ...(challenge ? { "www-authenticate": challenge } : {}),
      },
    });
  };
}

export function createMcpStateReporter(onState?: (event: OrbMcpState) => void) {
  const states = new Map<string, OrbMcpState["state"]>();
  return (
    server: string,
    state: OrbMcpState["state"],
    message?: string,
    diagnostic?: OrbMcpDiagnostic,
  ) => {
    const previous = states.get(server);
    if (previous === state) return;
    states.set(server, state);
    if (!previous && state === "connected") return;
    const notified = Result.fromThrowable(
      () =>
        onState?.({
          server,
          state,
          ...(message ? { message } : {}),
          ...(diagnostic ? { diagnostic } : {}),
        }),
      () => mcpError("unavailable", "MCP state telemetry unavailable"),
    )();
    if (notified.isErr()) console.error(notified.error.message);
  };
}

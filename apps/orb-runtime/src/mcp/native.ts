import {
  createMcpExtension,
  type McpExtensionOptions,
  StreamableHttpTransport,
} from "@earendil-works/pi-coding-agent";
import type { McpConfig } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, Result, ResultAsync, type Result as TypedResult } from "neverthrow";
import type { BrokerEnv } from "../broker/endpoint.ts";
import { resolveMcpHeaders } from "./boot.ts";
import { type McpError, mcpError } from "./error.ts";
import { HttpMcpTokenEndpoint, type McpAccessGrant, McpCredentialResolver } from "./oauth.ts";

type NativeOptions = ConstructorParameters<typeof StreamableHttpTransport>[0];
type NativeFetch = NonNullable<NativeOptions["fetch"]>;

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
  sessionId?: string;
  state: "failed" | "needs-auth" | "disconnected" | "connected";
  message?: string;
  diagnostic?: OrbMcpDiagnostic | undefined;
}

export interface OrbMcpExtensionDeps {
  configs: readonly McpConfig[];
  secrets: Readonly<Record<string, string>>;
  broker: BrokerEnv;
  task: SimulationTask;
  /** Persist and surface failure/recovery edges; callback receives no upstream body. */
  onState?: (event: OrbMcpState) => void;
}

/** Catalog headers are placeholders: only the request boundary supplies actual secrets. */
export function nativeMcpConfig(
  configs: readonly McpConfig[],
): ReturnType<NonNullable<McpExtensionOptions["loadConfig"]>> {
  return {
    errors: [],
    autoEnableCodemode: false,
    servers: configs.map((config) => ({
      name: config.name,
      scope: "extension" as const,
      source: "pi-orb",
      config: {
        url: config.url,
        exposure: "codemode" as const,
        headers: { Authorization: "pi-orb-broker" },
      },
    })),
  };
}

/** The platform fetch boundary never forwards upstream error bodies, URLs, or redirect credentials. */
export function createNativeMcpFetch(options: {
  config: McpConfig;
  headers: Record<string, string>;
  resolver?: McpCredentialResolver | undefined;
  task: SimulationTask;
  fetcher?: NativeFetch;
  onDiagnostic?: (diagnostic: OrbMcpDiagnostic | undefined) => void;
}): NativeFetch {
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
      // biome-ignore lint/plugin/no-throw: Pi's fetch hook requires a rejected promise on cancellation.
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
      // biome-ignore lint/plugin/no-throw: Pi's fetch hook requires a rejected promise on broker failure.
      throw new Error(credential.error.message);
    }
    if (signal.aborted) {
      // biome-ignore lint/plugin/no-throw: Pi's fetch hook requires a rejected promise on cancellation.
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
      // biome-ignore lint/plugin/no-throw: Pi's fetch hook requires a rejected promise on invalid headers.
      throw new Error(built.error.message);
    }
    const response = await ResultAsync.fromThrowable(
      () => fetcher(input, { ...init, headers: built.value, signal, redirect: "error" }),
      () => mcpError("unavailable", `MCP ${config.name} upstream unavailable`),
    )();
    if (response.isErr()) {
      report({ code: "network" });
      // biome-ignore lint/plugin/no-throw: Pi's fetch hook requires a rejected promise on network failure.
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
    // Keep the challenge for Pi's native retry decision; the remote body is discarded.
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

export function createNativeMcpTransport(options: {
  config: McpConfig;
  headers: Record<string, string>;
  resolver?: McpCredentialResolver | undefined;
  task: SimulationTask;
  fetcher?: NativeFetch;
  onDiagnostic?: (diagnostic: OrbMcpDiagnostic | undefined) => void;
}) {
  return new StreamableHttpTransport({
    url: options.config.url,
    // AuthProvider only enables native's bounded retry. It never receives or stores a token.
    ...(options.resolver
      ? { authProvider: { token: async () => undefined, onUnauthorized: async () => {} } }
      : {}),
    fetch: createNativeMcpFetch(options),
  });
}

export function createMcpStateReporter(
  onState?: OrbMcpExtensionDeps["onState"],
  sessionId?: () => string | undefined,
) {
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
    const source = sessionId?.();
    const notified = Result.fromThrowable(
      () =>
        onState?.({
          server,
          state,
          ...(source ? { sessionId: source } : {}),
          ...(message ? { message } : {}),
          ...(diagnostic ? { diagnostic } : {}),
        }),
      () => mcpError("unavailable", "MCP state telemetry unavailable"),
    )();
    if (notified.isErr()) console.error(notified.error.message);
  };
}

/** Native owns sessions and tool discovery. Each Pi session gets independent token caches. */
export function createOrbMcpExtension(
  deps: OrbMcpExtensionDeps,
): ReturnType<typeof createMcpExtension> {
  return (pi) => {
    const approved = new Map(deps.configs.map((config) => [config.name, config]));
    let sessionId: string | undefined;
    pi.on("session_start", (_event, ctx) => {
      sessionId = ctx.sessionManager.getSessionId();
    });
    const emit = createMcpStateReporter(deps.onState, () => sessionId);
    const diagnostics = new Map<string, OrbMcpDiagnostic>();
    const failedDiagnostics = new Map<string, OrbMcpDiagnostic>();
    // Pi never needs credential storage: the catalog disables its OAuth provider.
    const credentials = {
      forServer: () => ({
        load: () => undefined,
        save: () => {},
        withRefreshLock: async <T>(fn: () => Promise<T>) => fn(),
      }),
      tokens: () => undefined,
      remove: () => false,
    } as unknown as NonNullable<McpExtensionOptions["credentials"]>;
    return createMcpExtension({
      credentials,
      logPath: "/dev/null",
      loadConfig: () => nativeMcpConfig(deps.configs),
      retryConnectionOnPrompt: (name) => {
        if (!approved.get(name)?.oauth) return false;
        const diagnostic = failedDiagnostics.get(name);
        return (
          diagnostic?.code === "auth_required" ||
          diagnostic?.code === "broker_unavailable" ||
          diagnostic?.httpStatus === 401
        );
      },
      onServerChange: (name, state) => {
        if (state === "connecting") diagnostics.delete(name);
        else if (state === "failed") {
          const diagnostic = diagnostics.get(name) ?? { code: "connection_failed" as const };
          failedDiagnostics.set(name, diagnostic);
          if (diagnostic.code === "auth_required" || diagnostic.httpStatus === 401)
            emit(
              name,
              "needs-auth",
              `MCP ${name} authorization required; reconnect in project MCP settings`,
              {
                code: "auth_required",
                ...(diagnostic.httpStatus === 401 ? { httpStatus: 401 } : {}),
              },
            );
          else
            emit(name, "failed", `MCP ${name} unavailable; check project MCP settings`, diagnostic);
        } else if (state === "needs-auth") {
          failedDiagnostics.set(name, { code: "auth_required" });
          emit(
            name,
            "needs-auth",
            `MCP ${name} authorization required; reconnect in project MCP settings`,
            { code: "auth_required" },
          );
        } else if (state === "disconnected")
          emit(name, "disconnected", `MCP ${name} connection closed`, {
            code: "connection_failed",
          });
        if (state !== "connecting") diagnostics.delete(name);
        if (state === "connected") {
          failedDiagnostics.delete(name);
          emit(name, "connected");
        }
      },
      createTransport: (entry) => {
        const config = approved.get(entry.name);
        if (!config) {
          // biome-ignore lint/plugin/no-throw: Pi's transport factory must reject unapproved servers.
          throw new Error("Unapproved MCP server");
        }
        const headers = resolveMcpHeaders(config, deps.secrets);
        if (headers.isErr()) {
          diagnostics.set(config.name, { code: "invalid_binding" });
          emit(config.name, "failed", headers.error.message, { code: "invalid_binding" });
          // biome-ignore lint/plugin/no-throw: Pi's transport factory reports invalid bindings by throwing.
          throw new Error(headers.error.message);
        }
        const resolver = config.oauth
          ? new McpCredentialResolver(
              new HttpMcpTokenEndpoint(deps.broker, config.oauth.id, config.url),
            )
          : undefined;
        return createNativeMcpTransport({
          config,
          headers: headers.value,
          resolver,
          task: deps.task,
          onDiagnostic: (diagnostic) => {
            if (diagnostic) diagnostics.set(config.name, diagnostic);
            else diagnostics.delete(config.name);
          },
        });
      },
    })(pi);
  };
}

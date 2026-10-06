import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpConfig } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, Result, ResultAsync } from "neverthrow";
import type { BrokerEnv } from "../broker/endpoint.ts";
import { resolveMcpHeaders } from "../mcp/boot.ts";
import { type McpError, mcpError } from "../mcp/error.ts";
import {
  createMcpStateReporter,
  createNativeMcpFetch,
  type OrbMcpDiagnostic,
  type OrbMcpState,
} from "../mcp/native.ts";
import {
  HttpMcpTokenEndpoint,
  McpCredentialResolver,
  type McpTokenEndpoint,
} from "../mcp/oauth.ts";

export interface ClaudeMcpRuntime {
  mcpServers: NonNullable<Options["mcpServers"]>;
  close(): ResultAsync<void, McpError>;
}
export interface ClaudeMcpDeps {
  configs: readonly McpConfig[];
  secrets: Readonly<Record<string, string>>;
  broker: BrokerEnv;
  task: SimulationTask;
  onState?: (event: OrbMcpState) => void;
  /** Adapter boundaries for deterministic transport/broker tests. */
  clientFactory?: (config: McpConfig, fetcher: typeof fetch) => Client;
  tokenEndpoint?: (config: McpConfig) => McpTokenEndpoint;
  fetcher?: typeof fetch;
}

/** Native HTTP for static bindings; request-time broker transport for OAuth. */
export function createClaudeMcp(deps: ClaudeMcpDeps): Result<ClaudeMcpRuntime, McpError> {
  const resolved = deps.configs.map((config) => ({
    config,
    headers: resolveMcpHeaders(config, deps.secrets),
  }));
  for (const item of resolved) if (item.headers.isErr()) return err(item.headers.error);
  const mcpServers: ClaudeMcpRuntime["mcpServers"] = {};
  const closers: (() => Promise<Result<void, McpError>>)[] = [];
  const emit = createMcpStateReporter(deps.onState);
  const built = Result.fromThrowable(
    () => {
      for (const { config, headers } of resolved) {
        if (headers.isErr()) continue;
        if (!config.oauth) {
          mcpServers[config.name] = { type: "http", url: config.url, headers: headers.value };
          continue;
        }
        const resolver = new McpCredentialResolver(
          deps.tokenEndpoint?.(config) ??
            new HttpMcpTokenEndpoint(deps.broker, config.oauth.id, config.url),
        );
        const lifetime = new AbortController();
        let diagnostic: OrbMcpDiagnostic | undefined;
        const brokerFetch = createNativeMcpFetch({
          config,
          headers: headers.value,
          resolver,
          task: deps.task,
          ...(deps.fetcher ? { fetcher: deps.fetcher } : {}),
          onDiagnostic: (value) => {
            diagnostic = value;
            if (!diagnostic) emit(config.name, "connected");
            else if (diagnostic.code === "auth_required" || diagnostic.httpStatus === 401)
              emit(
                config.name,
                "needs-auth",
                `MCP ${config.name} authorization required; reconnect in project MCP settings`,
                { code: "auth_required" },
              );
            else
              emit(
                config.name,
                "failed",
                `MCP ${config.name} unavailable; check project MCP settings`,
                diagnostic,
              );
          },
        });
        const fetcher: typeof fetch = (input, init) =>
          brokerFetch(input instanceof Request ? input.url : input, {
            ...(input instanceof Request
              ? { method: input.method, headers: input.headers, signal: input.signal }
              : {}),
            ...init,
            signal: AbortSignal.any([
              lifetime.signal,
              ...(init?.signal ? [init.signal] : input instanceof Request ? [input.signal] : []),
            ]),
          });
        const client =
          deps.clientFactory?.(config, fetcher) ??
          new Client({ name: "pi-orb-claude", version: "1" });
        const server = new McpServer(
          { name: config.name, version: "1" },
          { capabilities: { tools: {}, resources: {}, prompts: {} } },
        );
        let opening: ResultAsync<void, McpError> | undefined;
        let closing = false;
        const pending = new Set<Promise<unknown>>();
        const execute = async <T>(action: () => Promise<T>): Promise<T> => {
          const work = async () => {
            if (closing) return err(mcpError("cancelled", "MCP connection closed"));
            opening ??= ResultAsync.fromThrowable(
              () =>
                client.connect(
                  new StreamableHTTPClientTransport(new URL(config.url), {
                    fetch: fetcher,
                  }) as Parameters<Client["connect"]>[0],
                ),
              () =>
                mcpError(
                  "unavailable",
                  `MCP ${config.name} unavailable; check project MCP settings`,
                ),
            )();
            const ready = await opening;
            if (ready.isErr()) {
              opening = undefined;
              return err(ready.error);
            }
            if (closing) return err(mcpError("cancelled", "MCP connection closed"));
            return ResultAsync.fromThrowable(action, () =>
              mcpError("unavailable", `MCP ${config.name} request failed; retry explicitly`),
            )();
          };
          const operation = work();
          pending.add(operation);
          const result = await operation;
          pending.delete(operation);
          if (result.isErr()) {
            if (!diagnostic && !closing)
              emit(config.name, "failed", result.error.message, { code: "connection_failed" });
            // biome-ignore lint/plugin/no-throw: MCP framework request handlers require protocol rejection.
            throw new Error(result.error.message);
          }
          return result.value;
        };
        // Raw protocol handlers preserve JSON Schema, pagination and remote result metadata.
        server.server.setRequestHandler(ListToolsRequestSchema, (request, extra) =>
          execute(() => client.listTools(request.params, { signal: extra.signal })),
        );
        server.server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
          execute(() => client.callTool(request.params, undefined, { signal: extra.signal })),
        );
        server.server.setRequestHandler(ListResourcesRequestSchema, (request, extra) =>
          execute(() => client.listResources(request.params, { signal: extra.signal })),
        );
        server.server.setRequestHandler(ListResourceTemplatesRequestSchema, (request, extra) =>
          execute(() => client.listResourceTemplates(request.params, { signal: extra.signal })),
        );
        server.server.setRequestHandler(ReadResourceRequestSchema, (request, extra) =>
          execute(() => client.readResource(request.params, { signal: extra.signal })),
        );
        server.server.setRequestHandler(ListPromptsRequestSchema, (request, extra) =>
          execute(() => client.listPrompts(request.params, { signal: extra.signal })),
        );
        server.server.setRequestHandler(GetPromptRequestSchema, (request, extra) =>
          execute(() => client.getPrompt(request.params, { signal: extra.signal })),
        );
        mcpServers[config.name] = { type: "sdk", name: config.name, instance: server };
        closers.push(async () => {
          closing = true;
          lifetime.abort();
          await opening;
          const results = await Promise.all([
            ResultAsync.fromThrowable(
              () => client.close(),
              () => mcpError("unavailable", `MCP ${config.name} cleanup failed`),
            )(),
            ResultAsync.fromThrowable(
              () => server.close(),
              () => mcpError("unavailable", `MCP ${config.name} cleanup failed`),
            )(),
          ]);
          await Promise.allSettled([...pending]);
          const failed = results.find((result) => result.isErr());
          return failed?.isErr() ? err(failed.error) : ok(undefined);
        });
      }
    },
    () => mcpError("invalid", "MCP configuration invalid"),
  )();
  if (built.isErr()) return err(built.error);
  let closed: ResultAsync<void, McpError> | undefined;
  return ok({
    mcpServers,
    close: () =>
      (closed ??= ResultAsync.fromSafePromise(Promise.all(closers.map((close) => close()))).andThen(
        (results) => {
          const failed = results.find((result) => result.isErr());
          return failed?.isErr() ? err(failed.error) : ok(undefined);
        },
      )),
  });
}

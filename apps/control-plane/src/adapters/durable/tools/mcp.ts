import { type Context, isJsonValue, type JsonValue } from "@earendil-works/chord";
import { type TSchema, Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { McpTransport } from "@earendil-works/pi-mcp";
import { McpClient, toLlmContent } from "@earendil-works/pi-mcp";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import { Check } from "typebox/value";
import { type CallableCatalog, errorResult, type ToolError } from "./catalog.ts";

/** connect must resolve scoped broker credentials afresh; no credentials are retained in the catalog. */
export interface McpEndpoint {
  name: string;
  description?: string;
  unavailableState?: () => "needs-auth" | "unavailable";
  connect(context: Context): ResultAsync<McpTransport, ToolError>;
}
export type McpServerStatus =
  | { name: string; status: "available" }
  | { name: string; status: "unavailable" | "needs-auth"; error: ToolError };
function invalidResponse(): ToolExecutionResult {
  return {
    isError: true,
    output: [{ type: "text", text: "Invalid MCP response" }],
    diagnostics: [{ severity: "error", code: "invalid_response", message: "Invalid MCP response" }],
  };
}
export class McpTools {
  private statuses: readonly McpServerStatus[] = [];
  status(): readonly McpServerStatus[] {
    return this.statuses;
  }
  statusTool() {
    return defineTool({
      name: "mcp_status",
      description: "Inspect MCP server availability and sanitized connection failures.",
      parameters: Type.Object({}, { additionalProperties: false }),
      replay: "safe",
      execute: async () => ({
        output: [{ type: "text" as const, text: JSON.stringify(this.statuses) }],
      }),
    });
  }
  private readonly running = new Set<McpClient>();
  private readonly resourceEndpoints = new Map<string, McpEndpoint>();
  private unavailable(endpoint: McpEndpoint, error: ToolError, api: ToolExecutionApi): void {
    if (error.code === "cancelled") return;
    const status = endpoint.unavailableState?.() ?? "unavailable";
    const previous = this.statuses.find((entry) => entry.name === endpoint.name);
    this.statuses = this.statuses.map((entry) =>
      entry.name === endpoint.name
        ? {
            name: endpoint.name,
            status,
            error: { code: error.code, message: "MCP server unavailable" },
          }
        : entry,
    );
    if (previous?.status !== status)
      api.diagnostic({
        severity: "info",
        code: "mcp_status",
        message: `MCP ${endpoint.name}: ${status}.`,
      });
  }
  private registerResources(): void {
    for (const name of [
      "list_mcp_resources",
      "list_mcp_resource_templates",
      "read_mcp_resource",
    ] as const) {
      const read = name === "read_mcp_resource";
      const registration = defineTool({
        name,
        description: read
          ? "Read an MCP resource by server and uri. Resolves to {server, uri, contents}; use image() for image blobs."
          : "List MCP resources or URI templates. Optional server/cursor returns one page; without server returns all servers.",
        parameters: read
          ? Type.Object(
              { server: Type.String(), uri: Type.String() },
              { additionalProperties: false },
            )
          : Type.Object(
              { server: Type.Optional(Type.String()), cursor: Type.Optional(Type.String()) },
              { additionalProperties: false },
            ),
        replay: "safe",
        structuredOutputSchema: Type.Object({}, { additionalProperties: true }),
        execute: async (args, api, ctx) => {
          const input = args as { server?: string; uri?: string; cursor?: string };
          if (input.cursor && !input.server)
            return errorResult({ code: "invalid_arguments", message: "cursor requires server" });
          const endpoints = input.server
            ? [this.resourceEndpoints.get(input.server)].filter(
                (v): v is McpEndpoint => v !== undefined,
              )
            : [...this.resourceEndpoints.values()];
          if (input.server && !endpoints.length)
            return errorResult({ code: "unavailable", message: "MCP resource server unavailable" });
          const rows: JsonValue[] = [];
          for (const endpoint of endpoints) {
            const response = await this.using<unknown>(endpoint, ctx, async (client) => {
              const options = { ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}) };
              if (read)
                return {
                  server: endpoint.name,
                  uri: input.uri!,
                  ...(await client.readResource(input.uri!, options)),
                };
              const key = name === "list_mcp_resources" ? "resources" : "resourceTemplates";
              if (input.server) {
                const page =
                  name === "list_mcp_resources"
                    ? await client.listResourcesPage(input.cursor, options)
                    : await client.listResourceTemplatesPage(input.cursor, options);
                const values = (page as unknown as Record<string, unknown>)[key];
                return {
                  server: endpoint.name,
                  ...page,
                  [key]: Array.isArray(values)
                    ? values.map((item) => ({ server: endpoint.name, ...item }))
                    : [],
                };
              }
              const items =
                name === "list_mcp_resources"
                  ? await client.listResources(options)
                  : await client.listResourceTemplates(options);
              return items.map((item) => ({ server: endpoint.name, ...item }));
            });
            if (response.isErr()) {
              this.unavailable(endpoint, response.error, api);
              return errorResult(response.error);
            }
            if (!isJsonValue(response.value)) return invalidResponse();
            rows.push(response.value);
          }
          const key = name === "list_mcp_resources" ? "resources" : "resourceTemplates";
          const scriptValue =
            read || input.server
              ? (rows[0] ?? {})
              : { [key]: rows.flatMap((row) => (Array.isArray(row) ? row : [])) };
          return {
            output: [{ type: "text", text: JSON.stringify(scriptValue) }],
            structuredOutput: scriptValue,
          };
        },
      });
      this.catalog.add(registration);
      this.catalog.metadata(name, {
        namespace: {
          name: "mcp",
          description: "MCP resources",
          instructions:
            "Use server names from MCP namespaces; list resources/templates before reading unfamiliar URIs.",
        },
        deferred: true,
      });
    }
  }
  private closed = false;
  private readonly endpoints: readonly McpEndpoint[];
  private readonly catalog: CallableCatalog;
  constructor(endpoints: readonly McpEndpoint[], catalog: CallableCatalog) {
    this.endpoints = endpoints;
    this.catalog = catalog;
  }
  private using<T>(
    endpoint: McpEndpoint,
    ctx: Context,
    fn: (client: McpClient) => Promise<T>,
  ): ResultAsync<T, ToolError> {
    if (this.closed) return errAsync({ code: "unavailable", message: "MCP tools closed" });
    if (ctx.abortSignal?.aborted) return errAsync({ code: "cancelled", message: "MCP cancelled" });
    const client = new McpClient({ name: "pi-orb", version: "1", requestTimeoutMs: 30_000 });
    this.running.add(client);
    return ResultAsync.fromSafePromise(
      (async () => {
        const abort = () => {
          void ResultAsync.fromPromise(client.close(), () => ({
            code: "cancelled" as const,
            message: "MCP cancelled",
          }));
        };
        ctx.abortSignal?.addEventListener("abort", abort, { once: true });
        const result = await ResultAsync.fromPromise(
          Promise.resolve().then(() =>
            this.closed || ctx.abortSignal?.aborted
              ? errAsync<McpTransport, ToolError>({ code: "cancelled", message: "MCP cancelled" })
              : endpoint.connect(ctx),
          ),
          () => ({ code: "unavailable" as const, message: "MCP broker connection failed" }),
        )
          .andThen((value) => value)
          .andThen((transport) => {
            if (this.closed || ctx.abortSignal?.aborted)
              return ResultAsync.fromPromise(transport.close(), () => ({
                code: "unavailable" as const,
                message: "MCP cleanup failed",
              })).andThen(() =>
                errAsync<T, ToolError>({ code: "cancelled", message: "MCP cancelled" }),
              );
            const failed = (): ToolError => ({
              code: ctx.abortSignal?.aborted ? "cancelled" : "unavailable",
              message: `MCP ${endpoint.name} request failed`,
            });
            return ResultAsync.fromThrowable(() => client.connect(transport), failed)().andThen(
              () => {
                if (this.closed || ctx.abortSignal?.aborted)
                  return errAsync<T, ToolError>({ code: "cancelled", message: "MCP cancelled" });
                const description = endpoint.description ?? client.serverInfo?.name;
                this.catalog.namespace({
                  name: `mcp__${endpoint.name}`,
                  ...(description ? { description } : {}),
                  ...(client.instructions ? { instructions: client.instructions } : {}),
                });
                return ResultAsync.fromThrowable(() => fn(client), failed)();
              },
            );
          });
        const cleanup = await ResultAsync.fromPromise(client.close(), () => ({
          code: "unavailable" as const,
          message: "MCP cleanup failed",
        }));
        ctx.abortSignal?.removeEventListener("abort", abort);
        this.running.delete(client);
        if (ctx.abortSignal?.aborted)
          return err<T, ToolError>({ code: "cancelled", message: "MCP cancelled" });
        if (result.isErr()) return result;
        return cleanup.map(() => result.value);
      })(),
    ).andThen((value) => value);
  }
  async discover(ctx: Context) {
    if (ctx.abortSignal?.aborted)
      return err<readonly McpServerStatus[], ToolError>({
        code: "cancelled",
        message: "MCP cancelled",
      });
    const statuses: McpServerStatus[] = [];
    for (const endpoint of this.endpoints) {
      const previous = this.statuses.find((status) => status.name === endpoint.name);
      if (previous?.status === "available") {
        statuses.push(previous);
        continue;
      }
      const discovered = await this.using(endpoint, ctx, async (client) => ({
        tools: client.serverCapabilities?.tools
          ? await client.listTools({ ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}) })
          : [],
        resources: !!client.serverCapabilities?.resources,
        instructions: client.instructions,
        description: endpoint.description ?? client.serverInfo?.name,
      }));
      if (discovered.isErr()) {
        if (discovered.error.code === "cancelled") return err(discovered.error);
        statuses.push({
          name: endpoint.name,
          status: endpoint.unavailableState?.() ?? "unavailable",
          error: { code: discovered.error.code, message: "MCP server unavailable" },
        });
        continue;
      }
      statuses.push({ name: endpoint.name, status: "available" });
      const namespace = {
        name: `mcp__${endpoint.name}`,
        ...(discovered.value.description ? { description: discovered.value.description } : {}),
        ...(discovered.value.instructions ? { instructions: discovered.value.instructions } : {}),
      };
      this.catalog.namespace(namespace);
      if (discovered.value.resources) {
        this.resourceEndpoints.set(endpoint.name, endpoint);
        this.registerResources();
      }
      for (const tool of discovered.value.tools) {
        const registered = defineTool({
          name: `mcp__${endpoint.name}__${tool.name}`,
          description: tool.description ?? tool.name,
          parameters: tool.inputSchema as TSchema,
          replay: "unsafe",
          structuredOutputSchema: Type.Object({
            content: Type.Array(Type.Unknown()),
            isError: Type.Optional(Type.Boolean()),
            _meta: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
            structuredContent: Type.Optional(
              (tool.outputSchema as TSchema | undefined) ?? Type.Unknown(),
            ),
          }),
          execute: async (args, api, context) => {
            let progress = okAsync<void, ToolError>(undefined);
            const called = await this.using(endpoint, context, (client) =>
              client.callTool(tool.name, args as Record<string, unknown>, {
                ...(context.abortSignal ? { signal: context.abortSignal } : {}),
                onProgress: (p) => {
                  if (api.details)
                    progress = progress.andThen(() =>
                      ResultAsync.fromPromise(
                        api.details(
                          {
                            progress: p.progress,
                            ...(p.total === undefined ? {} : { total: p.total }),
                          },
                          context,
                        ),
                        () => ({
                          code: "unavailable" as const,
                          message: "MCP progress publication failed",
                        }),
                      ),
                    );
                },
              }),
            );
            const published = await progress;
            if (published.isErr())
              api.diagnostic({
                severity: "warn",
                code: "mcp_progress_failed",
                message: published.error.message,
              });
            if (called.isErr()) {
              this.unavailable(endpoint, called.error, api);
              return errorResult(called.error);
            }
            const response = called.value;
            const rendered = Result.fromThrowable(
              (): ToolExecutionResult | undefined =>
                isJsonValue(response)
                  ? {
                      isError: response.isError ?? false,
                      output: toLlmContent(response),
                      structuredOutput: response,
                    }
                  : undefined,
              () => ({ code: "invalid_response" as const, message: "Invalid MCP tool response" }),
            )();
            if (rendered.isOk() && rendered.value) return rendered.value;
            return invalidResponse();
          },
        });
        const prepareArguments = registered.prepareArguments;
        this.catalog.add({
          ...registered,
          prepareArguments: (args) => {
            const valid = Result.fromThrowable(
              () => Check(tool.inputSchema, args),
              (): ToolError => ({ code: "invalid_arguments", message: "Invalid MCP arguments" }),
            )();
            if (valid.isErr() || !valid.value) {
              // biome-ignore lint/plugin/no-throw: Harness prepareArguments must throw to reject before coercion and hooks.
              throw new Error("Invalid MCP arguments");
            }
            return prepareArguments ? prepareArguments(args) : args;
          },
        } as ToolRegistration);
        this.catalog.metadata(registered.name, {
          namespace,
          deferred: true,
        });
      }
    }
    this.statuses = statuses;
    return ok(this.statuses);
  }
  close(): ResultAsync<void, ToolError> {
    this.closed = true;
    return ResultAsync.fromPromise(
      Promise.all([...this.running].map((c) => c.close())).then(() => {
        this.running.clear();
      }),
      () => ({ code: "unavailable", message: "MCP cleanup failed" }),
    );
  }
}

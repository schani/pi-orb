import { type Context, isJsonValue, type JsonValue } from "@earendil-works/chord";
import { type TSchema, Type } from "@earendil-works/pi-ai";
import { toCodemodeIdentifier } from "@earendil-works/pi-codemode";
import {
  defineTool,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { McpTransport } from "@earendil-works/pi-mcp";
import {
  McpAuthRequiredError,
  McpClient,
  McpHttpError,
  McpTimeoutError,
  toLlmContent,
} from "@earendil-works/pi-mcp";
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
  | { name: string; status: "pending" | "available" }
  | { name: string; status: "unavailable" | "needs-auth"; error: ToolError };
export type McpStatusChanged = (
  status: McpServerStatus,
  previous?: McpServerStatus,
) => ResultAsync<void, ToolError>;
export interface McpDiscoveryDiagnostics {
  now(): number;
  record(failure: {
    server: string;
    phase: "transport" | "initialize" | "list_tools" | "close";
    elapsedMs: number;
    aborted: boolean;
    errorCategory: ToolError["code"] | "request_timeout" | "http" | "auth_required";
    httpStatus?: number;
    requestTimeoutMs?: number;
  }): void;
}
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
  statusTool(retry: (ctx: Context) => void) {
    return defineTool({
      name: "mcp_status",
      description:
        "Inspect cached MCP availability; retry failed discovery in the background. Discovery starts automatically. Use discovered tools in the next script. " +
        this.statuses
          .map((s) => {
            const description = this.endpoints.find(
              (endpoint) => endpoint.name === s.name,
            )?.description;
            return `MCP ${s.name}: ${s.status} (mcp__${s.name})${description ? `: ${description}` : ""}`;
          })
          .join("; "),
      parameters: Type.Object({}, { additionalProperties: false }),
      replay: "safe",
      execute: async (_args, _api, ctx) => {
        retry(ctx);
        return { output: [{ type: "text", text: JSON.stringify(this.statuses) }] };
      },
    });
  }
  private readonly running = new Set<McpClient>();
  private readonly resourceEndpoints = new Map<string, McpEndpoint>();
  private publishStatus(status: McpServerStatus, ctx: Context): ResultAsync<void, ToolError> {
    if (this.closed || ctx.abortSignal?.aborted)
      return errAsync({ code: "cancelled", message: "MCP cancelled" });
    const previous = this.statuses.find((s) => s.name === status.name);
    this.statuses = this.statuses.map((s) => (s.name === status.name ? status : s));
    return this.changed(status, previous);
  }
  private unavailable(endpoint: McpEndpoint, error: ToolError, ctx: Context) {
    if (error.code === "cancelled") return okAsync(undefined);
    return this.publishStatus(
      {
        name: endpoint.name,
        status: endpoint.unavailableState?.() ?? "unavailable",
        error: { code: error.code, message: "MCP server unavailable" },
      },
      ctx,
    );
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
        execute: async (args, _api, ctx) => {
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
              const published = await this.unavailable(endpoint, response.error, ctx);
              return errorResult(published.isErr() ? published.error : response.error);
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
  private readonly diagnostics: McpDiscoveryDiagnostics | undefined;
  private readonly changed: McpStatusChanged;
  constructor(
    endpoints: readonly McpEndpoint[],
    catalog: CallableCatalog,
    diagnostics?: McpDiscoveryDiagnostics,
    changed: McpStatusChanged = () => okAsync(undefined),
  ) {
    this.endpoints = endpoints;
    this.catalog = catalog;
    this.diagnostics = diagnostics;
    this.changed = changed;
    this.statuses = endpoints.map(({ name }) => ({ name, status: "pending" }));
    for (const endpoint of endpoints)
      this.catalog.namespace({
        name: `mcp__${endpoint.name}`,
        description: `${endpoint.description ?? endpoint.name}: discovery pending`,
      });
  }
  private using<T>(
    endpoint: McpEndpoint,
    ctx: Context,
    fn: (client: McpClient) => Promise<T>,
    diagnostics?: McpDiscoveryDiagnostics,
  ): ResultAsync<T, ToolError> {
    if (this.closed) return errAsync({ code: "unavailable", message: "MCP tools closed" });
    if (ctx.abortSignal?.aborted) return errAsync({ code: "cancelled", message: "MCP cancelled" });
    const client = new McpClient({ name: "pi-orb", version: "1", requestTimeoutMs: 30_000 });
    this.running.add(client);
    return ResultAsync.fromSafePromise(
      (async () => {
        let phase: Parameters<McpDiscoveryDiagnostics["record"]>[0]["phase"] = "transport";
        let started = diagnostics?.now() ?? 0;
        let reported = false;
        const stage = (next: typeof phase) => {
          phase = next;
          started = diagnostics?.now() ?? 0;
        };
        const report = (category: ToolError["code"], cause?: unknown) => {
          if (!diagnostics || reported) return;
          reported = true;
          diagnostics.record({
            server: endpoint.name,
            phase,
            elapsedMs: diagnostics.now() - started,
            aborted: ctx.abortSignal?.aborted ?? false,
            errorCategory:
              cause instanceof McpTimeoutError
                ? "request_timeout"
                : cause instanceof McpAuthRequiredError
                  ? "auth_required"
                  : cause instanceof McpHttpError
                    ? "http"
                    : category,
            ...(cause instanceof McpHttpError ? { httpStatus: cause.status } : {}),
            ...(cause instanceof McpTimeoutError ? { requestTimeoutMs: cause.timeoutMs } : {}),
          });
        };
        const abort = () => {
          report("cancelled");
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
          .mapErr((error) => {
            report(error.code);
            return error;
          })
          .andThen((transport) => {
            if (this.closed || ctx.abortSignal?.aborted)
              return ResultAsync.fromPromise(transport.close(), () => ({
                code: "unavailable" as const,
                message: "MCP cleanup failed",
              })).andThen(() =>
                errAsync<T, ToolError>({ code: "cancelled", message: "MCP cancelled" }),
              );
            const failed = (cause: unknown): ToolError => {
              report("unavailable", cause);
              return {
                code: ctx.abortSignal?.aborted ? "cancelled" : "unavailable",
                message: `MCP ${endpoint.name} request failed`,
              };
            };
            stage("initialize");
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
                stage("list_tools");
                return ResultAsync.fromThrowable(() => fn(client), failed)();
              },
            );
          });
        stage("close");
        const cleanup = await ResultAsync.fromPromise(client.close(), () => {
          report("unavailable");
          return { code: "unavailable" as const, message: "MCP cleanup failed" };
        });
        ctx.abortSignal?.removeEventListener("abort", abort);
        this.running.delete(client);
        if (this.closed || ctx.abortSignal?.aborted)
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
    for (const endpoint of this.endpoints) {
      const previous = this.statuses.find((status) => status.name === endpoint.name);
      if (previous?.status === "available") continue;
      const discovered = await this.using(
        endpoint,
        ctx,
        async (client) => ({
          tools: client.serverCapabilities?.tools
            ? await client.listTools({ ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}) })
            : [],
          resources: !!client.serverCapabilities?.resources,
          instructions: client.instructions,
          description: endpoint.description ?? client.serverInfo?.name,
        }),
        this.diagnostics,
      ).andThen((value) => {
        const namespace = `mcp__${endpoint.name}`;
        const names = value.tools.map((tool) => `${namespace}__${tool.name}`);
        const identifiers = names.map(toCodemodeIdentifier);
        const occupied = this.catalog
          .registeredNames()
          .map((name) => [name, toCodemodeIdentifier(name)] as const);
        if (
          new Set(identifiers).size !== identifiers.length ||
          // Exact raw name and namespace identify the original endpoint/tool on retry.
          names.some((name, index) =>
            occupied.some(
              ([other, identifier]) =>
                identifier === identifiers[index] &&
                (other !== name || this.catalog.metadata(other).namespace?.name !== namespace),
            ),
          )
        )
          return err({ code: "unavailable" as const, message: "MCP tool name collision" });
        return ok(value);
      });
      if (discovered.isErr()) {
        if (discovered.error.code === "cancelled") return err(discovered.error);
        const status: McpServerStatus = {
          name: endpoint.name,
          status: endpoint.unavailableState?.() ?? "unavailable",
          error: { code: discovered.error.code, message: "MCP server unavailable" },
        };
        this.catalog.namespace({
          name: `mcp__${endpoint.name}`,
          description: `${endpoint.description ?? endpoint.name}: ${status.status}`,
        });
        const published = await this.publishStatus(status, ctx);
        if (published.isErr()) return err(published.error);
        continue;
      }
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
              const published = await this.unavailable(endpoint, called.error, context);
              return errorResult(published.isErr() ? published.error : called.error);
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
      const published = await this.publishStatus({ name: endpoint.name, status: "available" }, ctx);
      if (published.isErr()) return err(published.error);
    }
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

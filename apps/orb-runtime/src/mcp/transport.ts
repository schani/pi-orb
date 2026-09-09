import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { SimulationTask } from "determined";
import { err, ok, Result, ResultAsync, type Result as TypedResult } from "neverthrow";
import { mapMcpSdkError as failure } from "./sdk-error.ts";
import {
  type McpError,
  type McpOperation,
  type McpSession,
  type McpTransport,
  mcpError,
} from "./service.ts";
import type { McpEntry } from "./tools.ts";

const DEADLINE = 30_000;

/** Third-party MCP SDK boundary: never forwards raw upstream errors or credentials. */
export class HttpMcpTransport implements McpTransport {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  constructor(url: string, headers: Record<string, string>) {
    this.url = url;
    this.headers = headers;
  }

  async connect(
    _task: SimulationTask,
    signal: AbortSignal,
  ): Promise<TypedResult<McpSession, McpError>> {
    const initialized = Result.fromThrowable(
      () => ({
        client: new Client(
          { name: "pi-orb", version: "1" },
          { capabilities: {}, versionNegotiation: { mode: "auto" } },
        ),
        transport: new StreamableHTTPClientTransport(new URL(this.url), {
          requestInit: { headers: this.headers, redirect: "error" },
          reconnectionOptions: {
            maxRetries: 0,
            maxReconnectionDelay: 0,
            initialReconnectionDelay: 0,
            reconnectionDelayGrowFactor: 1,
          },
        }),
      }),
      failure,
    )();
    if (initialized.isErr()) return err(initialized.error);
    const { client, transport } = initialized.value;
    const result = await ResultAsync.fromPromise(
      client.connect(transport, { signal, timeout: DEADLINE }),
      failure,
    );
    if (result.isErr()) {
      await ResultAsync.fromPromise(client.close(), failure);
      return err(result.error);
    }
    return ok(new HttpMcpSession(client));
  }
}

class HttpMcpSession implements McpSession {
  private catalog: McpEntry[] | null = null;
  private readonly validator = new Ajv2020({ strict: false, validateFormats: false });
  private readonly client: Client;
  constructor(client: Client) {
    this.client = client;
  }

  private async load(signal: AbortSignal): Promise<TypedResult<McpEntry[], McpError>> {
    if (this.catalog) return ok(this.catalog);
    const capabilities = this.client.getServerCapabilities();
    const entries: McpEntry[] = [];
    const options = { signal, timeout: DEADLINE };
    const tooLarge = () =>
      mcpError(
        "invalid",
        "MCP catalog exceeds 5000 entries, 4MB, or 50 pages per kind, or repeats a cursor",
      );
    // Explicit cursors disable SDK auto-pagination. Publish only a complete catalog.
    const walk = async (
      fetchPage: (
        cursor: string | undefined,
      ) => Promise<{ nextCursor?: string | undefined; entries: McpEntry[] }>,
      optional = false,
    ): Promise<TypedResult<void, McpError>> => {
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (let page = 0; page < 50; page++) {
        const fetched = await ResultAsync.fromPromise(fetchPage(cursor), failure);
        if (fetched.isErr()) {
          if (optional && page === 0 && fetched.error.code === "unsupported") return ok(undefined);
          return err(fetched.error);
        }
        const result = fetched.value;
        entries.push(...result.entries);
        if (entries.length > 5000 || Buffer.byteLength(JSON.stringify(entries)) > 4_000_000)
          return err(tooLarge());
        if (!result.nextCursor) return ok(undefined);
        if (seen.has(result.nextCursor)) return err(tooLarge());
        seen.add(result.nextCursor);
        cursor = result.nextCursor;
      }
      return err(tooLarge());
    };
    if (capabilities?.tools) {
      const result = await walk(async (cursor) => {
        const r = await this.client.listTools({ cursor }, options);
        return {
          nextCursor: r.nextCursor,
          entries: r.tools.map((t) => ({
            kind: "tool" as const,
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        };
      });
      if (result.isErr()) return err(result.error);
    }
    if (capabilities?.prompts) {
      const result = await walk(async (cursor) => {
        const r = await this.client.listPrompts({ cursor }, options);
        return {
          nextCursor: r.nextCursor,
          entries: r.prompts.map((p) => ({
            kind: "prompt" as const,
            name: p.name,
            description: p.description,
            arguments: p.arguments,
          })),
        };
      });
      if (result.isErr()) return err(result.error);
    }
    if (capabilities?.resources) {
      const resources = await walk(async (cursor) => {
        const r = await this.client.listResources({ cursor }, options);
        return {
          nextCursor: r.nextCursor,
          entries: r.resources.map((r) => ({
            kind: "resource" as const,
            name: r.name,
            description: r.description,
            uri: r.uri,
          })),
        };
      }, true);
      if (resources.isErr()) return err(resources.error);
      const templates = await walk(async (cursor) => {
        const r = await this.client.listResourceTemplates({ cursor }, options);
        return {
          nextCursor: r.nextCursor,
          entries: r.resourceTemplates.map((r) => ({
            kind: "template" as const,
            name: r.name,
            description: r.description,
            uriTemplate: r.uriTemplate,
          })),
        };
      }, true);
      if (templates.isErr()) return err(templates.error);
    }
    this.catalog = entries;
    return ok(entries);
  }

  async perform(
    _task: SimulationTask,
    operation: McpOperation,
    signal: AbortSignal,
  ): Promise<TypedResult<unknown, McpError>> {
    const options = {
      signal: AbortSignal.any([signal, AbortSignal.timeout(DEADLINE)]),
      timeout: DEADLINE,
    };
    if (operation.method === "catalog") return this.load(options.signal);
    if (operation.method === "resources/read")
      return ResultAsync.fromPromise(
        this.client.readResource({ uri: operation.uri }, options),
        failure,
      );
    if (operation.method === "prompts/get")
      return ResultAsync.fromPromise(
        this.client.getPrompt({ name: operation.name, arguments: operation.arguments }, options),
        failure,
      );
    const catalog = await this.load(options.signal);
    if (catalog.isErr()) return err(catalog.error);
    const entry = catalog.value.find((e) => e.kind === "tool" && e.name === operation.name);
    if (!entry?.inputSchema)
      return err(mcpError("invalid", "Unknown MCP tool; search for its schema"));
    if (entry.inputSchema["$async"] !== undefined)
      return err(mcpError("invalid", "Async MCP tool schemas are unsupported"));
    const valid = Result.fromThrowable(
      () => this.validator.validate(entry.inputSchema ?? {}, operation.arguments),
      () => mcpError("invalid", "Unsupported MCP tool input schema"),
    )();
    if (valid.isErr()) {
      Result.fromThrowable(
        () => this.validator.removeSchema(entry.inputSchema),
        () => undefined,
      )();
      return err(valid.error);
    }
    if (!valid.value)
      return err(mcpError("invalid", "Invalid MCP tool arguments; search for its schema"));
    return ResultAsync.fromPromise(
      this.client.callTool({ name: operation.name, arguments: operation.arguments }, options),
      failure,
    );
  }
  close(): Promise<TypedResult<void, McpError>> {
    return Promise.resolve(ResultAsync.fromPromise(this.client.close(), failure));
  }
}

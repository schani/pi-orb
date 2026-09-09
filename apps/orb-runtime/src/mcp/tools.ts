import { err, ok, type Result } from "neverthrow";
import { Type } from "typebox";
import { Check } from "typebox/value";

const Entries = Type.Array(
  Type.Object({
    kind: Type.Union([
      Type.Literal("tool"),
      Type.Literal("prompt"),
      Type.Literal("resource"),
      Type.Literal("template"),
    ]),
    name: Type.String(),
    description: Type.Optional(Type.String()),
    uri: Type.Optional(Type.String()),
    uriTemplate: Type.Optional(Type.String()),
    inputSchema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    arguments: Type.Optional(Type.Array(Type.Unknown())),
  }),
);

import { type McpConnection, type McpError, type McpOperation, mcpError } from "./service.ts";

export type McpKind = "tool" | "prompt" | "resource" | "template";
export interface McpEntry {
  kind: McpKind;
  name: string;
  description?: string | undefined;
  uri?: string;
  uriTemplate?: string;
  inputSchema?: Record<string, unknown>;
  arguments?: unknown[] | undefined;
}
export class McpTools {
  private readonly connections: ReadonlyMap<string, McpConnection>;
  constructor(connections: ReadonlyMap<string, McpConnection>) {
    this.connections = connections;
  }

  async search(
    input: { query?: string; server?: string; kind?: McpKind; offset?: number; limit?: number },
    signal?: AbortSignal,
  ) {
    const items: (McpEntry & { server: string })[] = [];
    const failures: { server: string; error: McpError }[] = [];
    if (input.server && !this.connections.has(input.server))
      return err(mcpError("invalid", "MCP server does not exist"));
    const selected = [...this.connections].filter(
      ([server]) => !input.server || server === input.server,
    );
    const catalogs = await Promise.all(
      selected.map(async ([server, connection]) => ({
        server,
        result: await connection.perform({ method: "catalog" }, signal),
      })),
    );
    for (const { server, result } of catalogs) {
      if (result.isErr()) {
        failures.push({ server, error: result.error });
        continue;
      }
      if (!Check(Entries, result.value)) {
        failures.push({ server, error: mcpError("invalid", "Invalid MCP catalog") });
        continue;
      }
      for (const entry of result.value) {
        if (input.kind && entry.kind !== input.kind) continue;
        const text =
          `${server} ${entry.name} ${entry.description ?? ""} ${entry.uri ?? ""}`.toLowerCase();
        if (
          !(input.query ?? "")
            .toLowerCase()
            .split(/\s+/)
            .every((word) => text.includes(word))
        )
          continue;
        items.push({ ...entry, server });
      }
    }
    const offset = Math.max(0, input.offset ?? 0);
    const limit = Math.min(20, Math.max(1, input.limit ?? 5));
    return ok({
      items: items.slice(offset, offset + limit),
      total: items.length,
      nextOffset: offset + limit < items.length ? offset + limit : null,
      failures,
    });
  }

  private perform(
    server: string,
    operation: McpOperation,
    signal?: AbortSignal,
  ): Promise<Result<unknown, McpError>> {
    const connection = this.connections.get(server);
    return connection
      ? connection.perform(operation, signal)
      : Promise.resolve(err(mcpError("invalid", "MCP server does not exist")));
  }
  call(
    input: { server: string; tool: string; args?: Record<string, unknown> },
    signal?: AbortSignal,
  ) {
    return this.perform(
      input.server,
      { method: "tools/call", name: input.tool, arguments: input.args ?? {} },
      signal,
    );
  }
  async read(
    input: {
      server: string;
      kind: "prompt" | "resource" | "template";
      name?: string;
      uri?: string;
      args?: Record<string, string>;
    },
    signal?: AbortSignal,
  ): Promise<Result<unknown, McpError>> {
    if (input.kind === "resource" && input.uri)
      return this.perform(input.server, { method: "resources/read", uri: input.uri }, signal);
    if (input.kind === "prompt" && input.name) {
      const result = await this.perform(
        input.server,
        { method: "prompts/get", name: input.name, arguments: input.args ?? {} },
        signal,
      );
      return result.map((data) => ({
        source: { server: input.server, kind: "prompt", name: input.name },
        data,
      }));
    }
    if (input.kind === "template" && input.name) {
      const found = await this.perform(input.server, { method: "catalog" }, signal);
      if (found.isErr()) return found;
      if (!Check(Entries, found.value)) return err(mcpError("invalid", "Invalid MCP catalog"));
      const template = found.value.find((e) => e.kind === "template" && e.name === input.name);
      return template ? ok(template) : err(mcpError("invalid", "MCP template does not exist"));
    }
    return err(mcpError("invalid", "Supply a resource URI or prompt/template name"));
  }
  async close(): Promise<void> {
    await Promise.all([...this.connections.values()].map((connection) => connection.close()));
  }
}

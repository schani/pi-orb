import type { Context } from "@earendil-works/chord";
import type { TSchema } from "@earendil-works/pi-ai";
import type { CodemodeJsonSchema } from "@earendil-works/pi-codemode";
import { renderToolSample, toCodemodeIdentifier } from "@earendil-works/pi-codemode/declarations";
import {
  defineTool,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { ExecutionError, FileError } from "@earendil-works/pi-durable/env";
import { errAsync, okAsync, Result, ResultAsync } from "neverthrow";
import { Check } from "typebox/value";
import { Bm25Ranker, createToolSearchDocument } from "./vendor/search.ts";
import type { ToolNamespace } from "./vendor/types.ts";

export type ToolError = {
  code: "forbidden" | "invalid_arguments" | "unavailable" | "cancelled";
  message: string;
  output?: string;
};
export type AuthorizeTool = (
  name: string,
  args: unknown,
  api: ToolExecutionApi,
  context: Context,
) => ResultAsync<void, ToolError>;
const allow: AuthorizeTool = () => okAsync(undefined);
export function errorResult(error: ToolError): ToolExecutionResult {
  return {
    isError: true,
    content: [
      { type: "text", text: error.output ? `${error.output}\n${error.message}` : error.message },
    ],
    diagnostics: [{ severity: "error", code: error.code, message: error.message }],
  };
}

function preExecutionFailure(error: unknown): string | undefined {
  if (!(error instanceof ExecutionError) && !(error instanceof FileError)) return undefined;
  return new Set([
    "Host instructions adopted; re-evaluate the operation under the current instructions.",
    "Execution failed; use Start or new input to retry.",
    "Execution stopped by request.",
    "Execution unavailable during archival.",
    "execution admission revoked",
    "execution wait cancelled",
    "execution admission changed",
  ]).has(error.message)
    ? error.message
    : undefined;
}

function bashFailure(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if (error instanceof ExecutionError) {
    const safeTransportMessages = new Set([
      "execution transport failed; effects may have occurred",
      "execution stream interrupted; effects may have occurred",
      "execution cancellation not confirmed; effects may have occurred",
    ]);
    if (safeTransportMessages.has(error.message)) return error.message;
    const messages: Record<string, string> = {
      aborted: "Command aborted",
      timeout: "Command timed out",
      shell_unavailable: "Shell unavailable",
      spawn_error: "Shell process could not start",
      callback_error: "Shell output callback failed",
      unknown: "Shell execution failed; effects may have occurred",
    };
    return messages[error.code] ?? "Shell execution failed";
  }
  // Only the built-in tool's fixed-format failures are safe to expose.
  return /^(?:Command exited with code \d+|Command timed out after \d+(?:\.\d+)? seconds|Command aborted)$/.test(
    error.message,
  )
    ? error.message
    : undefined;
}

export interface CallableMetadata {
  namespace?: ToolNamespace;
  outputSchema?: CodemodeJsonSchema;
  deferred?: boolean;
  /** Full MCP or structured output; deliberately separate from public Durable content. */
  project?: (result: ToolExecutionResult) => unknown;
}
function namespaceMatches(namespace: string, query: string): boolean {
  const id = toCodemodeIdentifier(namespace);
  const queryId = toCodemodeIdentifier(query);
  return (
    namespace === query ||
    id === queryId ||
    namespace.split("__").at(-1) === query ||
    id.split("__").at(-1) === queryId
  );
}
/** The same gate serves model calls and every nested sandbox callback. */
export class CallableCatalog {
  private readonly entries = new Map<string, ToolRegistration>();
  private readonly authorize: AuthorizeTool;
  private readonly meta = new Map<string, CallableMetadata>();
  private readonly namespaces = new Map<string, ToolNamespace>();
  namespace(value: ToolNamespace): void {
    this.namespaces.set(value.name, value);
  }
  namespaceValues(): readonly ToolNamespace[] {
    return [...this.namespaces.values()];
  }
  metadata(name: string, value?: CallableMetadata): CallableMetadata {
    if (value) {
      this.meta.set(name, value);
      if (value.namespace) this.namespace(value.namespace);
    }
    const metadata = this.meta.get(name) ?? {};
    return metadata.namespace
      ? {
          ...metadata,
          namespace: this.namespaces.get(metadata.namespace.name) ?? metadata.namespace,
        }
      : metadata;
  }
  policyTools() {
    return this.definitions().map((tool) => ({
      ...tool,
      outputSchema: this.metadata(tool.name).outputSchema ?? { type: "string" },
    }));
  }
  constructor(tools: readonly ToolRegistration[], authorize: AuthorizeTool = allow) {
    this.authorize = authorize;
    for (const tool of tools) this.add(tool);
  }
  add(tool: ToolRegistration): void {
    if (tool.name === "codemode") return;
    this.entries.set(tool.name, tool);
    if (tool.name.startsWith("orb_"))
      this.metadata(tool.name, {
        namespace: {
          name: "orb",
          description: "Orb lifecycle and conversation operations",
          instructions:
            "Use archive/delete only on explicit user request. Stop/sleep revokes execution admission; a connected browser does not override Stop.",
        },
      });
  }
  definitions(): readonly ToolRegistration[] {
    return [...this.entries.values()];
  }
  describe(name: string) {
    const tool = this.policyTools().find(
      (t) => t.name === name || toCodemodeIdentifier(t.name) === name,
    );
    return tool
      ? renderToolSample({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.parameters as CodemodeJsonSchema,
          outputSchema: tool.outputSchema,
        })
      : undefined;
  }
  describeNamespace(name: string) {
    const tools = this.definitions().filter((t) => {
      const ns = this.metadata(t.name).namespace;
      return ns && namespaceMatches(ns.name, name);
    });
    const namespace = tools[0]
      ? this.metadata(tools[0].name).namespace
      : [...this.namespaces.values()].find((ns) => namespaceMatches(ns.name, name));
    return namespace
      ? { ...namespace, tools: tools.map((t) => toCodemodeIdentifier(t.name)) }
      : undefined;
  }
  search(query: string, options: { limit?: number; namespace?: string } = {}) {
    const documents = this.definitions()
      .filter(
        (t) =>
          !options.namespace ||
          (this.metadata(t.name).namespace &&
            namespaceMatches(this.metadata(t.name).namespace!.name, options.namespace)),
      )
      .map((t) => createToolSearchDocument(t, this.metadata(t.name).namespace));
    return new Bm25Ranker().rank(query, documents, options.limit ?? 8).map((t) => ({
      name: toCodemodeIdentifier(t.name),
      description: this.describe(t.name) ?? "",
    }));
  }
  invoke(
    name: string,
    args: unknown,
    api: ToolExecutionApi,
    context: Context,
  ): ResultAsync<ToolExecutionResult, ToolError> {
    const tool = this.entries.get(name);
    if (!tool) return errAsync({ code: "unavailable", message: "Unknown tool" });
    const prepared = Result.fromThrowable(
      () => (tool.prepareArguments ? tool.prepareArguments(args) : args),
      () => ({ code: "invalid_arguments" as const, message: `Invalid arguments for ${name}` }),
    )();
    if (prepared.isErr()) return errAsync(prepared.error);
    const value = prepared.value;
    const valid = Result.fromThrowable(
      () => Check(tool.parameters as TSchema, value),
      () => false,
    )();
    if (valid.isErr() || !valid.value)
      return errAsync({ code: "invalid_arguments", message: `Invalid arguments for ${name}` });
    if (context.abortSignal?.aborted)
      return errAsync({ code: "cancelled", message: "Tool cancelled" });
    return this.authorize(name, value, api, context).andThen(() => {
      if (context.abortSignal?.aborted)
        return errAsync<ToolExecutionResult, ToolError>({
          code: "cancelled",
          message: "Tool cancelled",
        });
      let output = "";
      const executionApi =
        name === "bash"
          ? {
              ...api,
              output: (text: string | Uint8Array) => {
                const decoded =
                  typeof text === "string" ? text : Buffer.from(text).toString("utf8");
                output = Buffer.from(output + decoded)
                  .subarray(-50 * 1024)
                  .toString("utf8");
                api.output(text);
              },
            }
          : api;
      return ResultAsync.fromPromise(
        Promise.resolve().then(() => tool.execute(value as never, executionApi, context)),
        (error): ToolError => ({
          code: context.abortSignal?.aborted ? "cancelled" : "unavailable",
          message:
            preExecutionFailure(error) ??
            (name === "bash" ? bashFailure(error) : undefined) ??
            `${name} failed`,
          ...(name === "bash" && output ? { output } : {}),
        }),
      );
    });
  }
  registrations(): ToolRegistration[] {
    return this.definitions().map((tool) =>
      defineTool({
        ...tool,
        execute: async (args, api, ctx) => {
          const result = await this.invoke(tool.name, args, api, ctx);
          return result.isOk() ? result.value : errorResult(result.error);
        },
      }),
    );
  }
}

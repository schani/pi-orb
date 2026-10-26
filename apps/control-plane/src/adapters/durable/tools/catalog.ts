import type { Context } from "@earendil-works/chord";
import type { TSchema } from "@earendil-works/pi-ai";
import type { CodemodeJsonSchema } from "@earendil-works/pi-codemode";
import {
  defineTool,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import { ExecutionError, FileError } from "@earendil-works/pi-durable/env";
import { errAsync, okAsync, Result, ResultAsync } from "neverthrow";
import { Check } from "typebox/value";

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
    output: [
      { type: "text", text: error.output ? `${error.output}\n${error.message}` : error.message },
    ],
    diagnostics: [{ severity: "error", code: error.code, message: error.message }],
  };
}

function preExecutionFailure(error: unknown): string | undefined {
  if (!(error instanceof ExecutionError) && !(error instanceof FileError)) return undefined;
  return new Set([
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

type ToolNamespace = Omit<CodemodeNamespace, "prefix">;

const nativeOutputSchema: CodemodeJsonSchema = {
  anyOf: [
    { type: "string" },
    {
      type: "array",
      items: {
        anyOf: [
          {
            type: "object",
            required: ["type", "text"],
            properties: {
              type: { const: "text" },
              text: { type: "string" },
              textSignature: { type: "string" },
            },
          },
          {
            type: "object",
            required: ["type", "data", "mimeType"],
            properties: {
              type: { const: "image" },
              data: { type: "string" },
              mimeType: { type: "string" },
            },
          },
        ],
      },
    },
  ],
};

export interface CallableMetadata {
  namespace?: ToolNamespace;
  outputSchema?: CodemodeJsonSchema;
  deferred?: boolean;
}
/** The same gate serves model calls and every nested sandbox callback. */
export class CallableCatalog {
  private readonly entries: Map<string, ToolRegistration>;
  private readonly authorize: AuthorizeTool;
  private readonly meta: Map<string, CallableMetadata>;
  private readonly namespaces: Map<string, ToolNamespace>;
  private readonly hidden: ReadonlySet<string>;
  /** Same entries minus `names`; later additions, such as discovered MCP tools, reach both. */
  without(names: readonly string[]): CallableCatalog {
    return new CallableCatalog([], this.authorize, { catalog: this, hide: names });
  }
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
  nativeNamespaces(): readonly CodemodeNamespace[] {
    return this.namespaceValues().flatMap((namespace) =>
      (namespace.name === "mcp"
        ? ["list_mcp_", "read_mcp_"]
        : [namespace.name === "orb" ? "orb_" : `${namespace.name}__`]
      ).map((prefix) => ({ ...namespace, prefix })),
    );
  }
  constructor(
    tools: readonly ToolRegistration[],
    authorize: AuthorizeTool = allow,
    base?: { catalog: CallableCatalog; hide: readonly string[] },
  ) {
    this.authorize = authorize;
    this.entries = base?.catalog.entries ?? new Map();
    this.meta = base?.catalog.meta ?? new Map();
    this.namespaces = base?.catalog.namespaces ?? new Map();
    this.hidden = new Set([...(base?.catalog.hidden ?? []), ...(base?.hide ?? [])]);
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
  /** Shared occupancy, including entries hidden from this view. */
  registeredNames(): readonly string[] {
    return [...this.entries.keys()];
  }
  definitions(): readonly ToolRegistration[] {
    return [...this.entries.values()].filter((tool) => !this.hidden.has(tool.name));
  }
  invalidArgumentsMessage(name: string, args: unknown): string {
    const generic = `Invalid arguments for ${name}`;
    const tool = this.hidden.has(name) ? undefined : this.entries.get(name);
    if (!tool || typeof args !== "object" || args === null || Array.isArray(args)) return generic;
    const required = "required" in tool.parameters ? tool.parameters.required : undefined;
    if (!Array.isArray(required)) return generic;
    const missing: string[] = [];
    let length = 0;
    for (const field of required) {
      if (typeof field !== "string" || field.length > 64 || Object.hasOwn(args, field)) continue;
      const quoted = JSON.stringify(field);
      if (missing.length === 16 || length + quoted.length + 2 > 1024) break;
      missing.push(quoted);
      length += quoted.length + 2;
    }
    return missing.length ? `${generic}. Missing required fields: ${missing.join(", ")}` : generic;
  }
  invoke(
    name: string,
    args: unknown,
    api: ToolExecutionApi,
    context: Context,
    preparedArguments = false,
  ): ResultAsync<ToolExecutionResult, ToolError> {
    const tool = this.hidden.has(name) ? undefined : this.entries.get(name);
    if (!tool) return errAsync({ code: "unavailable", message: "Unknown tool" });
    const prepared = Result.fromThrowable(
      () => (!preparedArguments && tool.prepareArguments ? tool.prepareArguments(args) : args),
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
      let outputBytes = 0;
      const started = performance.now();
      const executionApi =
        name === "bash"
          ? {
              ...api,
              outputWindow: undefined,
              retainedOutput: () => ({ text: output, truncated: outputBytes > 50 * 1024 }),
              output: (text: string | Uint8Array) => {
                const decoded =
                  typeof text === "string" ? text : Buffer.from(text).toString("utf8");
                outputBytes += Buffer.byteLength(decoded);
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
      ).map((result) => {
        if (
          name !== "bash" ||
          typeof result.structuredOutput !== "object" ||
          result.structuredOutput === null ||
          !("exitCode" in result.structuredOutput) ||
          typeof result.structuredOutput.exitCode !== "number"
        )
          return result;
        const value = result.structuredOutput as {
          output: string;
          truncated: boolean;
          fullOutputPath?: string;
          exitCode: number;
        };
        return {
          ...result,
          output: result.output ?? [{ type: "text" as const, text: output }],
          ...(this.metadata(name).outputSchema
            ? {
                structuredOutput: {
                  output: value.output,
                  truncated: value.truncated,
                  ...(value.fullOutputPath ? { full_output_path: value.fullOutputPath } : {}),
                  exit_code: value.exitCode,
                  wall_time_seconds: (performance.now() - started) / 1000,
                },
              }
            : {}),
        };
      });
    });
  }
  registrations(): ToolRegistration[] {
    return this.definitions().map((tool) => {
      const metadata = this.metadata(tool.name);
      return defineTool({
        ...tool,
        callers: ["tools"],
        ...(tool.prepareArguments
          ? {
              prepareArguments: (args: unknown) => {
                const prepared = Result.fromThrowable(
                  () => tool.prepareArguments!(args),
                  () => `Invalid arguments for ${tool.name}`,
                )();
                if (prepared.isErr()) {
                  // biome-ignore lint/plugin/no-throw: Harness repair contract rejects by throwing
                  throw new Error(prepared.error);
                }
                return prepared.value;
              },
            }
          : {}),
        ...(metadata.deferred ? { deferred: true as const } : {}),
        structuredOutputSchema:
          metadata.outputSchema ?? tool.structuredOutputSchema ?? nativeOutputSchema,
        execute: async (args, api, ctx) => {
          const called = await this.invoke(tool.name, args, api, ctx, true);
          if (called.isErr()) return errorResult(called.error);
          const result = called.value;
          if (result.structuredOutput !== undefined) return result;
          const output = result.output ?? [
            { type: "text" as const, text: api.retainedOutput?.().text ?? "" },
          ];
          if (result.isError)
            return {
              ...result,
              diagnostics: [
                ...(result.diagnostics ?? []),
                ...(result.diagnostics?.some((item) => item.severity === "error")
                  ? []
                  : [
                      {
                        severity: "error" as const,
                        code: "tool_failed",
                        message:
                          output
                            .filter((item) => item.type === "text")
                            .map((item) => item.text)
                            .join("\n") || `${tool.name} failed`,
                      },
                    ]),
              ],
            };
          return {
            ...result,
            structuredOutput: output.some((item) => item.type === "image")
              ? output.map((item) =>
                  item.type === "image"
                    ? { type: "image" as const, data: item.data, mimeType: item.mimeType }
                    : {
                        type: "text" as const,
                        text: item.text,
                        ...(item.textSignature !== undefined
                          ? { textSignature: item.textSignature }
                          : {}),
                      },
                )
              : output
                  .filter((item) => item.type === "text")
                  .map((item) => item.text)
                  .join("\n"),
          };
        },
      });
    });
  }
}

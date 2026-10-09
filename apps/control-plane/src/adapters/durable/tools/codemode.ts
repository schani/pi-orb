import type { JsonValue } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import { Type, type Usage } from "@earendil-works/pi-ai";
import {
  CodemodeSandbox,
  type CodemodeTool,
  parseCodemodeSource,
} from "@earendil-works/pi-codemode";
import { CODEMODE_SOURCE_GRAMMAR } from "@earendil-works/pi-codemode/source";
import {
  defineDoc,
  defineTool,
  type ToolExecutionApi,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { err, Result, ResultAsync } from "neverthrow";
import {
  CALLBACK_LIMIT_MESSAGE,
  MAX_CALLBACK_CONCURRENCY,
  MAX_CALLBACK_REPLY_BYTES,
} from "./callback-limits.js";
import { type CallableCatalog, errorResult } from "./catalog.ts";
import { codeModeCpuBudget } from "./cpu-budget.js";
import type { AgentToolFiles } from "./files.ts";
import { createCodemodeDescription, DEFAULT_CODEMODE_INLINE_BUDGET } from "./vendor/description.ts";
import { createDiscoveryGlobals } from "./vendor/discovery.ts";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  formatError,
  type NestedCall,
  valueText,
} from "./vendor/output.ts";
import { truncateOutput } from "./vendor/output-budget.ts";
import { combineUsage } from "./vendor/usage.ts";

const CodemodeStore = defineDoc<Record<string, JsonValue>>({
  kind: "orb.codemode-store",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}),
});
const MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
const MAX_CAPTURE = 1024 * 1024;
function textOf(result: ToolExecutionResult) {
  return (result.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}
function appendBounded(current: string, chunk: string) {
  const combined = current + chunk;
  if (Buffer.byteLength(combined) <= MAX_CAPTURE) return combined;
  const bytes = Buffer.from(combined);
  const marker = "\n…output omitted…\n";
  const half = Math.floor((MAX_CAPTURE - Buffer.byteLength(marker)) / 2);
  let headEnd = half;
  let tailStart = bytes.length - half;
  while ((bytes[headEnd]! & 0xc0) === 0x80) headEnd--;
  while ((bytes[tailStart]! & 0xc0) === 0x80) tailStart++;
  return bytes.toString("utf8", 0, headEnd) + marker + bytes.toString("utf8", tailStart);
}

export function codemodeTool(
  catalog: CallableCatalog,
  running: Set<CodemodeSandbox>,
  files: AgentToolFiles = {},
) {
  return defineTool({
    name: "codemode",
    description:
      createCodemodeDescription(catalog.policyTools(), {
        inlineBudget: DEFAULT_CODEMODE_INLINE_BUDGET,
        namespaces: new Map(
          catalog.definitions().flatMap((t) => {
            const ns = catalog.metadata(t.name).namespace;
            return ns ? [[t.name, ns] as const] : [];
          }),
        ),
        deferred: new Set(
          catalog
            .definitions()
            .filter((t) => catalog.metadata(t.name).deferred)
            .map((t) => t.name),
        ),
      }) +
      catalog
        .namespaceValues()
        .map(
          (ns) =>
            `\nNamespace ${ns.name}: discover with describeNamespace(${JSON.stringify(ns.name)}).${ns.description ? ` ${ns.description}` : ""}${ns.instructions ? `\n${ns.instructions}` : ""}`,
        )
        .join("") +
      "\nDo not redeclare tools or other injected globals. Discover children with `text(await searchTools('subagent'))`. Only script output reaches the model. The default deadline is five minutes; timeout_ms overrides it. Batch independent calls with Promise.allSettled in batches of at most 8: tool calls and host discovery globals share the 8-outstanding limit. Each execution allows 256 total callbacks, 8 MiB serialized arguments, and 64 MiB serialized replies; exceeding a limit cancels the script and callbacks without saving store writes. Chain calls or filter results. Failed scripts do not undo earlier effects; nested operations are not independently replayed. Successful store writes persist per conversation. Images must use image(), not text().",
    parameters: Type.Object({ code: Type.String() }, { additionalProperties: false }),
    constrainedSampling: { type: "grammar", variants: { openai_lark: CODEMODE_SOURCE_GRAMMAR } },
    replay: "unsafe",
    execute: async (args, api, ctx) => {
      const started = performance.now();
      const parsed = Result.fromThrowable(
        () => parseCodemodeSource(args.code),
        (e) => ({
          code: "invalid_arguments" as const,
          message: e instanceof Error ? e.message : "Invalid source options",
        }),
      )();
      if (parsed.isErr()) return errorResult(parsed.error);
      const store = await ResultAsync.fromPromise(
        api.commit(
          async (tx) =>
            JSON.parse(JSON.stringify(await tx.doc(CodemodeStore, api.conversationId))) as Record<
              string,
              JsonValue
            >,
          ctx,
        ),
        () => ({ code: "unavailable" as const, message: "Sandbox store read failed" }),
      );
      if (store.isErr()) return errorResult(store.error);
      const calls: NestedCall[] = [];
      const callbackAbort = new AbortController();
      const executionSignal = ctx.abortSignal
        ? AbortSignal.any([ctx.abortSignal, callbackAbort.signal])
        : callbackAbort.signal;
      let callbackLimit = false;
      let activeCallbacks = 0;
      let replyBytes = 0;
      const limitCallbacks = () => {
        callbackLimit = true;
        callbackAbort.abort(new Error(CALLBACK_LIMIT_MESSAGE));
      };
      const guardCallback = (tool: CodemodeTool): CodemodeTool => ({
        ...tool,
        execute: async (value, options) => {
          if (executionSignal.aborted) return undefined;
          if (activeCallbacks >= MAX_CALLBACK_CONCURRENCY) {
            limitCallbacks();
            return undefined;
          }
          activeCallbacks++;
          try {
            const called = await ResultAsync.fromPromise(
              Promise.resolve().then(() => tool.execute(value, options)),
              (error) => (error instanceof Error ? error.message : "Callback failed"),
            );
            if (executionSignal.aborted || options.signal.aborted) return undefined;
            const serialized = called.isOk()
              ? Result.fromThrowable(
                  () => JSON.stringify(called.value),
                  () => "Callback result serialization failed",
                )()
              : err<string | undefined, string>(called.error);
            const payload = serialized.isOk() ? serialized.value : serialized.error;
            replyBytes += Buffer.byteLength(payload ?? "", "utf8");
            if (replyBytes > MAX_CALLBACK_REPLY_BYTES) {
              limitCallbacks();
              return undefined;
            }
            if (serialized.isErr()) {
              // biome-ignore lint/plugin/no-throw: public QuickJS callback rejection contract
              throw new Error(serialized.error);
            }
            // Snapshot the bounded JSON so upstream serialization cannot invoke getters again.
            return payload === undefined ? undefined : JSON.parse(payload);
          } finally {
            activeCallbacks--;
          }
        },
      });
      let invocation = 0;
      let usage: Usage | undefined;
      const publish = async () => {
        if (!api.details) return;
        const published = await ResultAsync.fromPromise(
          api.details(
            {
              calls: calls.map((c) => ({ ...c })),
              omittedCalls: Math.max(0, invocation - calls.length),
              executionWait: calls.some((c) => c.status === "running" && c.executionWait === true),
            },
            ctx,
          ),
          () => ({ code: "unavailable" as const, message: "Nested progress publication failed" }),
        );
        if (published.isErr())
          api.diagnostic?.({
            severity: "warn",
            code: "codemode_progress_failed",
            message: published.error.message,
          });
      };
      const cpu = codeModeCpuBudget.acquire();
      const created = Result.fromThrowable(
        () =>
          new CodemodeSandbox({
            memoryLimitBytes: MEMORY_LIMIT_BYTES,
            workerUrl: new URL("./bounded-worker.js", import.meta.url),
            workerData: cpu.workerData,
            tools: catalog
              .definitions()
              .map(
                (t): CodemodeTool => ({
                  name: t.name,
                  description: catalog.describe(t.name) ?? t.description,
                  execute: async (value, { signal }) => {
                    const record: NestedCall = {
                      id: `${api.callId}:nested:${invocation++}`,
                      name: t.name,
                      args: JSON.stringify(
                        typeof value === "object" && value !== null
                          ? Object.keys(value).slice(0, 16)
                          : typeof value,
                      ).slice(0, 256),
                      status: "running",
                    };
                    calls.push(record);
                    if (calls.length > 64) calls.shift();
                    const began = performance.now();
                    let output = "";
                    let total = 0;
                    let details: JsonValue | undefined;
                    const diagnostics: NonNullable<ToolExecutionResult["diagnostics"]>[number][] =
                      [];
                    let exitCode: number | undefined;
                    let spillPath: string | undefined;
                    const env =
                      t.name === "bash" && api.env
                        ? new Proxy(api.env, {
                            get(target, key) {
                              if (key === "exec")
                                return async (...args: Parameters<typeof target.exec>) => {
                                  const result = await target.exec(...args);
                                  if (result.ok) {
                                    exitCode = result.value.exitCode;
                                    spillPath = result.value.spillPath;
                                  }
                                  return result;
                                };
                              const v = Reflect.get(target, key);
                              return typeof v === "function" ? v.bind(target) : v;
                            },
                          })
                        : api.env;
                    await publish();
                    const nestedApi = {
                      ...api,
                      env,
                      callId: record.id,
                      output: (chunk: string | Uint8Array) => {
                        const decoded =
                          typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
                        total += Buffer.byteLength(decoded);
                        output = appendBounded(output, decoded);
                      },
                      diagnostic: (d: NonNullable<ToolExecutionResult["diagnostics"]>[number]) => {
                        if (diagnostics.length < 16) diagnostics.push(d);
                      },
                      details: async (d: JsonValue) => {
                        details = d;
                        if (typeof d === "object" && d !== null && !Array.isArray(d)) {
                          if (typeof d.executionWait === "boolean")
                            record.executionWait = d.executionWait;
                          if (typeof d.progress === "number") record.progress = d.progress;
                          if (typeof d.total === "number") record.total = d.total;
                        }
                        await publish();
                      },
                    } as ToolExecutionApi;
                    const called = await catalog.invoke(
                      t.name,
                      value,
                      nestedApi,
                      withAbortSignal(signal, ctx),
                    );
                    if (called.isOk() && called.value.usage)
                      usage = usage ? combineUsage(usage, called.value.usage) : called.value.usage;
                    record.durationMs = performance.now() - began;
                    record.status = signal.aborted
                      ? "cancelled"
                      : called.isErr() || called.value.isError
                        ? "error"
                        : "ok";
                    if (called.isErr()) record.error = called.error.message.slice(0, 256);
                    else if (called.value.isError) record.error = `${t.name} reported failure`;
                    if (diagnostics.length)
                      record.diagnostics = diagnostics.map((d) => ({
                        code: d.code ?? "tool_diagnostic",
                        severity: d.severity,
                      }));
                    await publish();
                    if (t.name === "bash" && exitCode !== undefined) {
                      return {
                        output:
                          output ||
                          (called.isErr() ? (called.error.output ?? "") : textOf(called.value)),
                        truncated: total > MAX_CAPTURE,
                        ...(spillPath ? { full_output_path: spillPath } : {}),
                        exit_code: exitCode,
                        wall_time_seconds: record.durationMs / 1000,
                      };
                    }
                    if (called.isErr()) {
                      // QuickJS callback contract uses rejected promises; typed failure stops at this adapter boundary.
                      // biome-ignore lint/plugin/no-throw: third-party QuickJS callback contract
                      throw new Error(
                        called.error.output
                          ? `${called.error.output}\n${called.error.message}`
                          : called.error.message,
                      );
                    }
                    const final = {
                      ...called.value,
                      content: called.value.content ?? [{ type: "text" as const, text: output }],
                      ...((called.value.details ?? details) === undefined
                        ? {}
                        : { details: called.value.details ?? details! }),
                      diagnostics: [...diagnostics, ...(called.value.diagnostics ?? [])],
                    };
                    const project = catalog.metadata(t.name).project;
                    if (project) {
                      const projected = project(final);
                      if (projected !== undefined) return projected;
                    }
                    if (final.isError) {
                      // biome-ignore lint/plugin/no-throw: third-party QuickJS callback contract
                      throw new Error(textOf(final) || `${t.name} failed`);
                    }
                    if (final.content.some((b) => b.type === "image")) return final.content;
                    return textOf(final);
                  },
                }),
              )
              .map(guardCallback),
            globals: createDiscoveryGlobals(
              catalog.policyTools(),
              new Map(catalog.definitions().map((t) => [t.name, catalog.describe(t.name) ?? ""])),
              {
                getToolNamespace: (name) => catalog.metadata(name).namespace,
                getNamespaces: () => catalog.namespaceValues(),
              },
            ).map(guardCallback),
          }),
        () => ({ code: "unavailable" as const, message: "Sandbox initialization failed" }),
      )();
      if (created.isErr()) {
        cpu.release();
        return errorResult(created.error);
      }
      const sandbox = created.value;
      running.add(sandbox);
      const run = await ResultAsync.fromPromise(
        sandbox.execute(parsed.value.code, {
          store: store.value,
          ...(parsed.value.options.timeoutMs === undefined
            ? {}
            : { timeoutMs: parsed.value.options.timeoutMs }),
          signal: executionSignal,
        }),
        () => ({ code: "unavailable" as const, message: "Sandbox execution failed" }),
      );
      const closed = await ResultAsync.fromPromise(sandbox.close(), () => ({
        code: "unavailable" as const,
        message: "Sandbox cleanup failed",
      }));
      running.delete(sandbox);
      cpu.release();
      const cpuStats = cpu.snapshot();
      if (run.isErr()) return errorResult(run.error);
      if (closed.isErr()) return errorResult(closed.error);
      const value = run.value;
      const resourceLimit =
        callbackLimit || (!value.ok && value.error.message === CALLBACK_LIMIT_MESSAGE);
      for (const call of calls) if (call.status === "running") call.status = "cancelled";
      if (
        value.ok &&
        (Object.keys(value.storeWrites.set).length || value.storeWrites.delete.length)
      ) {
        const saved = await ResultAsync.fromPromise(
          api.commit(async (tx) => {
            const doc = await tx.doc(CodemodeStore, api.conversationId);
            for (const [key, item] of Object.entries(value.storeWrites.set))
              doc[key] = item as JsonValue;
            for (const key of value.storeWrites.delete) delete doc[key];
          }, ctx),
          () => ({ code: "unavailable" as const, message: "Sandbox store commit failed" }),
        );
        if (saved.isErr()) return errorResult(saved.error);
      }
      let items: NonNullable<ToolExecutionResult["content"]> = [
        ...value.output,
        ...(value.ok && value.value !== undefined
          ? [{ type: "text" as const, text: valueText(value.value) }]
          : []),
        ...(!value.ok
          ? [{ type: "text" as const, text: `Script error:\n${formatError(value, calls)}` }]
          : []),
      ];
      const truncated = await truncateOutput(
        items,
        parsed.value.options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        async (text) => {
          const spilled = files.spill ? await files.spill(text, api, ctx) : undefined;
          return spilled?.isOk()
            ? { path: spilled.value }
            : { error: "scoped artifact storage unavailable" };
        },
      );
      const fullOutputPath = truncated.fullOutputPath;
      if (truncated.items !== items)
        api.diagnostic?.({
          severity: fullOutputPath ? "info" : "warn",
          code: "codemode_output_truncated",
          message: fullOutputPath
            ? "Code-mode output spilled to a private artifact."
            : "Code-mode output truncated; artifact storage unavailable.",
        });
      items = truncated.items;
      return {
        content: [
          {
            type: "text",
            text: `${value.ok ? "Script completed" : "Script failed"}\nWall time ${((performance.now() - started) / 1000).toFixed(1)} seconds${cpuStats.throttledMs >= 100 ? `\nCPU budget wait ${(cpuStats.throttledMs / 1000).toFixed(1)} seconds` : ""}\nOutput:\n`,
          },
          ...items,
        ],
        isError: !value.ok,
        ...(resourceLimit
          ? {
              diagnostics: [
                {
                  severity: "error" as const,
                  code: "resource_limit",
                  message: CALLBACK_LIMIT_MESSAGE,
                },
              ],
            }
          : {}),
        ...(usage ? { usage } : {}),
        details: {
          cpu: cpuStats,
          calls: calls.map((c) => ({ ...c })),
          omittedCalls: Math.max(0, invocation - calls.length),
          executionWait: false,
          ...(fullOutputPath ? { fullOutputPath } : {}),
        },
      };
    },
  });
}

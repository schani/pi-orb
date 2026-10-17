import { type Context, copyJson } from "@earendil-works/chord";
import { CodemodeSandbox, parseCodemodeSource } from "@earendil-works/pi-codemode";
import {
  defineTool,
  type Extension,
  type JsonObject,
  LiveDoc,
  type ToolExecutionApi,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import {
  CodemodeJournalDoc,
  CodemodeRunDoc,
  createCodemodeExtension,
  createCodemodeTool,
} from "@earendil-works/pi-durable/codemode";
import { type ExecutionEnv, FileError } from "@earendil-works/pi-durable/env";
import { CHART_MAX_PER_SCRIPT, type ChartSpec, parseChartSpec } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { Result, ResultAsync } from "neverthrow";
import { CALLBACK_LIMIT_MESSAGE } from "./callback-limits.js";
import { type CallableCatalog, errorResult } from "./catalog.ts";
import { PiCodemodeSandbox } from "./codemode-sandbox.ts";
import type { AgentToolFiles } from "./files.ts";

const POLICY =
  "\nOnly codemode is offered to the model. Do not redeclare tools or other injected globals. Tool calls and discovery share an 8-outstanding limit; each script allows 256 callbacks, 8 MiB serialized arguments and 64 MiB serialized replies. Exceeding a resource limit cancels the script without saving store writes. The default deadline is five minutes; timeout_ms overrides it. Batch independent calls with Promise.allSettled in batches of at most 8. Native nested calls retain their own replay policy; failed scripts do not undo effects. Images must use image(), not text(). await chart(spec) shows the user a separate chart row; its data is not returned to the model. spec is {kind:'line',title,unit?,source?,series:[{name,points:[[time,value|null]]}],markers?:[{at:time,label}],thresholds?:[{value,label}]} (ISO or epoch-ms time, at most 6 series/5000 points) or {kind:'bar',title,unit?,source?,bars:[{label,value}]}. source is an http(s) origin link. At most 8 charts per script.";

function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function argumentKeys(args: unknown): string {
  return JSON.stringify(
    object(args) || Array.isArray(args) ? Object.keys(args).slice(0, 16) : typeof args,
  ).slice(0, 256);
}
function chartEntries(entries: unknown): ChartSpec[] {
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry: unknown) => {
    if (
      !object(entry) ||
      !object(entry.global) ||
      entry.global.name !== "chart" ||
      !object(entry.global.outcome) ||
      entry.global.outcome.ok !== true
    )
      return [];
    const parsed = parseChartSpec(entry.global.args);
    return parsed.isOk() ? [parsed.value] : [];
  });
}

/** Native journal/scheduler; this adapter only decorates policy and presentation. */
export function codemodeTool(
  catalog: CallableCatalog,
  running: Set<CodemodeSandbox>,
  files: AgentToolFiles = {},
  orb?: { id: string; task: SimulationTask },
) {
  const options = {
    sandbox: new PiCodemodeSandbox(),
    models: false,
    get namespaces() {
      return catalog.nativeNamespaces();
    },
  };
  const native = createCodemodeTool(options);
  return defineTool({
    ...native,
    description:
      native.description.replace(
        "`image()` also saves the image to a temp file and the result names its path.",
        "Images are returned inline.",
      ) + POLICY,
    execute: async (args, api, context) => {
      const parsed = Result.fromThrowable(
        () => parseCodemodeSource(args.code),
        () => ({ code: "invalid_arguments" as const, message: "Invalid code-mode source options" }),
      )();
      if (parsed.isErr()) return errorResult(parsed.error);
      // Record the default deadline too, so a restart cannot extend it.
      const source =
        parsed.value.options.timeoutMs === undefined
          ? `// @options: ${JSON.stringify({ timeout_ms: 300_000, ...(parsed.value.options.maxOutputTokens === undefined ? {} : { max_output_tokens: parsed.value.options.maxOutputTokens }) })}\n${parsed.value.code}`
          : args.code;
      const sandbox = new PiCodemodeSandbox({
        running,
        ...(orb ? { orb } : {}),
        execution: { conversationId: String(api.conversationId), callId: api.callId },
      });
      const previews = new Map<number, { args: string; argumentKeys: string[] }>();
      const paths = new Map<string, string>();
      const directory = `/orb-artifacts/codemode-${api.taskId}`;
      let charts: ChartSpec[] = [];
      let chartCount = 0;
      const replacePaths = (text: string) => {
        for (const [path, replacement] of paths) text = text.replaceAll(path, replacement);
        return text;
      };
      const project = (value: ToolExecutionResult): ToolExecutionResult => {
        const details = object(value.details) ? value.details : {};
        const allCalls = Array.isArray(details.calls) ? details.calls.filter(object) : [];
        const calls = allCalls.slice(-64).map((call) => ({
          ...call,
          ...(typeof call.id === "number" && previews.has(call.id) ? previews.get(call.id)! : {}),
        }));
        return {
          ...value,
          output: (value.output ?? []).map((item) =>
            item.type !== "text"
              ? item
              : {
                  ...item,
                  text: item.text.startsWith("The script took a different path")
                    ? "The script cannot resume: its call history changed."
                    : replacePaths(item.text),
                },
          ),
          details: {
            ...details,
            calls,
            omittedCalls:
              (typeof details.omittedCalls === "number" ? details.omittedCalls : 0) +
              Math.max(0, allCalls.length - 64),
            executionWait: false,
            ...(typeof details.fullOutputPath === "string"
              ? { fullOutputPath: replacePaths(details.fullOutputPath) }
              : {}),
            ...(charts.length ? { charts: copyJson(charts) } : {}),
          },
        };
      };
      const present = (value: ToolExecutionResult): ToolExecutionResult => {
        const resources = sandbox.snapshot();
        let result = project(value);
        const cached = object(result.details) && "cpu" in result.details;
        if (!cached)
          result = {
            ...result,
            details: {
              ...(object(result.details) ? result.details : {}),
              cpu: resources.cpu,
              memory: resources.memory,
            },
          };
        const diagnostics = [...(result.diagnostics ?? [])];
        if (resources.callbackLimit && !diagnostics.some((item) => item.code === "resource_limit"))
          diagnostics.push({
            severity: "error",
            code: "resource_limit",
            message: CALLBACK_LIMIT_MESSAGE,
          });
        const spilled = object(result.details) && typeof result.details.fullOutputPath === "string";
        if (
          !diagnostics.some((item) => item.code === "codemode_output_truncated") &&
          (spilled ||
            result.output?.some(
              (item) => item.type === "text" && item.text.includes("Warning: truncated output"),
            ))
        )
          diagnostics.push({
            severity: spilled ? "info" : "warn",
            code: "codemode_output_truncated",
            message: spilled
              ? "Code-mode output spilled to a private artifact."
              : "Code-mode output truncated; artifact storage unavailable.",
          });
        if (resources.cpu.throttledMs >= 100 && !cached)
          result = {
            ...result,
            output: (result.output ?? []).map((item, index) =>
              index === 0 && item.type === "text"
                ? {
                    ...item,
                    text: item.text.replace(
                      "\nOutput:",
                      `\nCPU budget wait ${(resources.cpu.throttledMs / 1000).toFixed(1)} seconds\nOutput:`,
                    ),
                  }
                : item,
            ),
          };
        result = { ...result, ...(diagnostics.length ? { diagnostics } : {}) };
        return result;
      };
      const env = new Proxy(api.env ?? ({} as ExecutionEnv), {
        get(target, key) {
          if (key === "createTempDir") return async () => ({ ok: true as const, value: directory });
          if (key === "writeFile")
            return async (path: string, data: string | Uint8Array, ctx: Context) => {
              if (path !== `${directory}/output.txt` || typeof data !== "string" || !files.spill)
                return {
                  ok: false as const,
                  error: new FileError("not_supported", "scoped artifact storage unavailable"),
                };
              const spilled = await files.spill(data, api, ctx);
              if (spilled.isErr())
                return {
                  ok: false as const,
                  error: new FileError("unknown", "scoped artifact storage unavailable"),
                };
              paths.set(path, spilled.value);
              return { ok: true as const, value: undefined };
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const decorated: ToolExecutionApi = {
        ...api,
        env,
        executeTool: (name, value, ctx, callOptions) => {
          const id = Number(callOptions?.key?.slice(1));
          if (Number.isSafeInteger(id))
            previews.set(id, {
              args: argumentKeys(value),
              argumentKeys:
                object(value) || Array.isArray(value) ? Object.keys(value).slice(0, 16) : [],
            });
          return api.executeTool(name, value, ctx, callOptions).then((result) => ({
            ...result,
            diagnostics: result.diagnostics.map((diagnostic) =>
              diagnostic.code === "invalid_arguments"
                ? { ...diagnostic, message: `Invalid arguments for ${name}` }
                : diagnostic,
            ),
          }));
        },
        commit: (change, ctx) =>
          api.commit(async (tx) => {
            const result = await change(tx);
            const run = await tx.doc(CodemodeRunDoc, api.taskId);
            const recorded = chartEntries(
              copyJson((await tx.doc(CodemodeJournalDoc, api.taskId)).entries),
            );
            if (recorded.length !== charts.length) {
              charts = recorded;
              const live = await tx.doc(LiveDoc, api.conversationId);
              const slot = [...(live.tools ?? []), ...(live.nestedTools ?? [])].find(
                (item) => item.taskId === api.taskId,
              );
              if (slot)
                slot.details = {
                  ...(object(slot.details) ? slot.details : {}),
                  charts: copyJson(charts),
                };
            }
            if (run.result !== undefined) {
              // Artifact paths and chart rows commit with the native outcome, before it can be replayed.
              run.result = copyJson(present(run.result as ToolExecutionResult), {
                omitUndefinedProperties: true,
              }) as JsonObject;
            }
            return object(result) && Array.isArray(result.output)
              ? (copyJson(present(result as ToolExecutionResult), {
                  omitUndefinedProperties: true,
                }) as typeof result)
              : result;
          }, ctx),
      };
      const executed = await ResultAsync.fromPromise(
        (async () => {
          const previous = await api.snapshot(CodemodeJournalDoc, api.taskId, context);
          chartCount = chartEntries(previous?.entries ?? []).length;
          const tool = createCodemodeTool({
            ...options,
            sandbox,
            globals: [
              {
                name: "chart",
                execute: async (value) => {
                  const parsed = parseChartSpec(value);
                  if (parsed.isErr() || chartCount >= CHART_MAX_PER_SCRIPT) {
                    // biome-ignore lint/plugin/no-throw: native globals reject validation errors into the script
                    throw new Error(
                      parsed.isErr()
                        ? parsed.error.message
                        : `chart(): at most ${CHART_MAX_PER_SCRIPT} charts per script`,
                    );
                  }
                  chartCount++;
                  return undefined;
                },
              },
            ],
          });
          return tool.execute({ code: source }, decorated, context);
        })(),
        () => ({
          code: context.abortSignal?.aborted ? ("cancelled" as const) : ("unavailable" as const),
          message: context.abortSignal?.aborted
            ? "Code-mode cancelled"
            : "Code-mode execution failed",
        }),
      );
      const cleanup = await ResultAsync.fromPromise(
        (async () => {
          await sandbox.close();
          await sandbox.drained();
        })(),
        () => ({ code: "unavailable" as const, message: "Code-mode cleanup failed" }),
      );
      if (executed.isErr())
        return {
          ...errorResult(executed.error),
          ...(charts.length ? { details: { charts: copyJson(charts) } } : {}),
        };
      if (cleanup.isErr()) return errorResult(cleanup.error);
      return present(executed.value);
    },
  });
}

export function codemodeExtension(
  catalog: CallableCatalog,
  running: Set<CodemodeSandbox>,
  files?: AgentToolFiles,
  orb?: { id: string; task: SimulationTask },
): Extension {
  const extension = createCodemodeExtension({
    sandbox: new PiCodemodeSandbox(),
    models: false,
    get namespaces() {
      return catalog.nativeNamespaces();
    },
  });
  return {
    ...extension,
    tools: [codemodeTool(catalog, running, files, orb)],
    sections: (extension.sections ?? []).map((section) => ({
      ...section,
      render: async (input, context) => {
        const declarations = await section.render(input, context);
        const namespaces = catalog
          .namespaceValues()
          .map(
            (namespace) =>
              `Namespace ${namespace.name}: discover with describeNamespace(${JSON.stringify(namespace.name)}).${namespace.instructions ? `\n${namespace.instructions}` : ""}`,
          );
        return [declarations, ...namespaces].filter(Boolean).join("\n\n") || undefined;
      },
    })),
  };
}

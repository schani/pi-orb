import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  type Conversation,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  type HookRegistration,
  MemoryStorage,
  type Storage,
  type ToolExecutionApi,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { SimulationTask } from "determined";
import type { CallableCatalog } from "../catalog.ts";
import { codemodeTool } from "../codemode.ts";
import type { AgentToolFiles } from "../files.ts";

const context = BACKGROUND_CONTEXT;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Real model/nested tasks; optional holding supports explicit replay assertions. */
export async function openCodemodeHarness(
  catalog: CallableCatalog,
  options: {
    files?: AgentToolFiles;
    env?: ExecutionEnv;
    storage?: Storage;
    orb?: { id: string; task: SimulationTask };
    onResult?: (source: string, result: ToolExecutionResult) => void;
    holdForReplay?: boolean;
    hooks?: readonly HookRegistration[];
    now?: () => number;
  } = {},
) {
  const code = codemodeTool(catalog, new Set(), options.files, options.orb);
  let executing = 0;
  let complete = deferred<ToolExecutionResult>();
  let release = deferred<void>();
  let active: { api: ToolExecutionApi; args: { code: string } } | undefined;
  let batch:
    | {
        results: ToolExecutionResult[];
        expected: number;
        done: ReturnType<typeof deferred<ToolExecutionResult[]>>;
      }
    | undefined;
  const registration = defineTool({
    ...code,
    execute: async (args, api, ctx) => {
      executing++;
      const result = await code.execute(args, api, ctx);
      executing--;
      options.onResult?.(args.code, result);
      if (batch) {
        batch.results.push(result);
        if (batch.results.length === batch.expected) batch.done.resolve(batch.results);
        return result;
      }
      active = { api, args };
      complete.resolve(result);
      if (options.holdForReplay)
        await Promise.race([
          release.promise,
          new Promise<void>((resolve) => {
            if (ctx.abortSignal?.aborted) resolve();
            else ctx.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
          }),
        ]);
      return result;
    },
  });
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "native-test",
      ...(options.hooks ? { hooks: options.hooks } : {}),
      tools: [...catalog.registrations(), registration],
    }),
  );
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const storage = options.storage ?? new MemoryStorage();
  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      ...(options.env ? { env: () => options.env! } : {}),
      ...(options.now ? { now: options.now } : {}),
    },
    context,
  );
  const root = await harness.root(context, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
  });
  harness.resume();
  let pending: Promise<unknown> | undefined;
  return {
    harness,
    root,
    storage,
    async run(source: string, conversation: Conversation = root) {
      if (pending) {
        release.resolve();
        await pending;
      }
      batch = undefined;
      complete = deferred<ToolExecutionResult>();
      release = deferred<void>();
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("codemode", { code: source }), { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
      ]);
      const submission = await conversation.submit({ type: "input", content: "run" }, context);
      pending = submission.wait(context);
      const result = await Promise.race([
        complete.promise,
        pending.then(() => {
          throw new Error("Code-mode invocation did not complete");
        }),
      ]);
      if (!options.holdForReplay) await pending;
      return result;
    },
    async runMany(sources: string[]) {
      if (pending) {
        release.resolve();
        await pending;
      }
      batch = { results: [], expected: sources.length, done: deferred<ToolExecutionResult[]>() };
      faux.setResponses([
        fauxAssistantMessage(
          sources.map((code, index) =>
            fauxToolCall("codemode", { code }, { id: `parallel-${index}` }),
          ),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("done"),
      ]);
      const submission = await root.submit({ type: "input", content: "parallel" }, context);
      pending = submission.wait(context);
      const results = await Promise.race([
        batch.done.promise,
        pending.then(() => {
          throw new Error("Parallel code-mode invocations did not complete");
        }),
      ]);
      await pending;
      return results;
    },
    async settle() {
      release.resolve();
      if (pending) await pending;
      pending = undefined;
    },
    async abort() {
      release.resolve();
      await root.abort(context, { background: true });
      if (pending) await pending;
      pending = undefined;
    },
    async replay() {
      if (!options.holdForReplay) throw new Error("Replay requires holdForReplay");
      if (!active) throw new Error("No active code-mode invocation");
      return code.execute(active.args, active.api, context);
    },
    async close() {
      release.resolve();
      if (executing) await root.abort(context, { background: true });
      if (pending) await pending;
      await harness.close(context);
    },
  };
}

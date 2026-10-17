import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineTool,
  Harness,
  MemoryStorage,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { MemoryAgentPersistence } from "../memory-persistence.testkit.ts";
import { CallableCatalog } from "./catalog.ts";
import { ChildReceipts, createDurableTools } from "./index.ts";

const context = BACKGROUND_CONTEXT;
describe("Durable callable tools", () => {
  it("validates nested arguments and authorizes every QuickJS callback", async () => {
    let calls = 0;
    let permits = 0;
    const echo = defineTool({
      name: "echo",
      description: "echo",
      parameters: Type.Object({ value: Type.String() }),
      execute: async ({ value }) => {
        calls++;
        return { output: [{ type: "text", text: value }] };
      },
    });
    const catalog = new CallableCatalog([echo], () => {
      permits++;
      return errAsync({ code: "forbidden", message: "denied" });
    });
    const api = {} as ToolExecutionApi;
    expect((await catalog.invoke("echo", { value: 1 }, api, context)).isErr()).toBe(true);
    expect((await catalog.invoke("echo", { value: "x" }, api, context)).isErr()).toBe(true);
    expect(calls).toBe(0);
    expect(permits).toBe(1);
  });

  it("maps synchronous third-party tool failures to a sanitized typed error", async () => {
    const catalog = new CallableCatalog([
      defineTool({
        name: "external",
        description: "external",
        parameters: Type.Object({}),
        execute: () => {
          // biome-ignore lint/plugin/no-throw: third-party callback failure fixture
          throw new Error("secret-token=unsafe");
        },
      }),
    ]);
    const outcome = await catalog.invoke("external", {}, {} as ToolExecutionApi, context);
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr())
      expect(outcome.error).toEqual({ code: "unavailable", message: "external failed" });
  });

  it("does not execute a tool canceled during asynchronous authorization", async () => {
    const abort = new AbortController();
    let release!: () => void;
    const permitted = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const catalog = new CallableCatalog(
      [
        defineTool({
          name: "effect",
          description: "effect",
          parameters: Type.Object({}),
          execute: async () => {
            calls++;
            return { output: [] };
          },
        }),
      ],
      () => ResultAsync.fromSafePromise(permitted),
    );
    const invocation = catalog.invoke(
      "effect",
      {},
      {} as ToolExecutionApi,
      withAbortSignal(abort.signal, context),
    );
    abort.abort();
    release();
    const outcome = await invocation;
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) expect(outcome.error.code).toBe("cancelled");
    expect(calls).toBe(0);
  });

  it("runs actual QuickJS callbacks through Durable and retains images and errors", async () => {
    const png = {
      type: "image" as const,
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jg9sAAAAASUVORK5CYII=",
      mimeType: "image/png",
    };
    const executed: string[] = [];
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("codemode", {
          code: `const r = await tools.echo({value:"ok"});
            if (typeof r === "string") text(r);
            else for (const block of r) {
              if (block.type === "image") image(block);
              else text(block.text);
            }
            image(${JSON.stringify(png)});
            try { await tools.echo({value:"denied"}); }
            catch (error) { text(String(error)); }`,
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const tools = createDurableTools({
      additionalTools: [
        defineTool({
          name: "echo",
          description: "echo",
          parameters: Type.Object({ value: Type.String() }),
          execute: async ({ value }) => {
            executed.push(value);
            return {
              output: [{ type: "text", text: value }, png, { type: "text", text: "after" }],
            };
          },
        }),
      ],
      authorize: (_name, args) =>
        (args as { value?: string }).value === "denied"
          ? errAsync({ code: "forbidden", message: "Denied by policy" })
          : okAsync(undefined),
    });
    const registry = createRegistry();
    registry.install(tools.extension);
    registry.install(tools.childExtension);
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
    try {
      const root = await harness.root(context, {
        agent: {
          model: { provider: "faux", modelId: "faux-1" },
          modelTools: tools.modelTools,
          extensions: { remove: [tools.childExtension] },
        },
      });
      harness.resume();
      await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
      const entries = await root.entries({}, 100, undefined, context);
      const result = entries.items
        .flatMap((e) => e.model ?? [])
        .find((m) => m.role === "toolResult");
      expect(result?.isError).toBe(false);
      const lines =
        result?.content.flatMap((block) => (block.type === "text" ? block.text.split("\n") : [])) ??
        [];
      expect(lines.filter((line) => line === "ok" || line === "after")).toEqual(["ok", "after"]);
      expect(lines.filter((line) => line.includes("Denied by policy"))).toHaveLength(1);
      const images = result?.content.filter((block) => block.type === "image") ?? [];
      expect(images).toEqual([png, png]);
      expect(images.map((block) => block.data.length)).toEqual([png.data.length, png.data.length]);
      expect(executed).toEqual(["ok"]);
    } finally {
      await harness.close(context);
      await tools.close();
    }
  });

  it("starts owned background children immediately and persists receipts", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    let entered!: () => void;
    const childStarted = new Promise<void>((r) => {
      entered = r;
    });
    const faux = fauxProvider();
    let parentCalls = 0;
    const respond: FauxResponseFactory = async (request, options) => {
      if (
        JSON.stringify(request.messages).includes('"child"') &&
        !JSON.stringify(request.messages).includes('"toolResult"')
      ) {
        entered();
        await Promise.race([
          blocked,
          new Promise<void>((resolve) => {
            if (options?.signal?.aborted) resolve();
            else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
          }),
        ]);
        return options?.signal?.aborted
          ? fauxAssistantMessage("", { stopReason: "aborted" })
          : fauxAssistantMessage("child result");
      }
      parentCalls++;
      return fauxAssistantMessage("parent done");
    };
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("codemode", {
          code: 'text(JSON.parse(await tools.subagent({prompt:"child"})));',
        }),
        { stopReason: "toolUse" },
      ),
      respond,
      respond,
      respond,
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const tools = createDurableTools();
    const registry = createRegistry();
    registry.install(tools.extension);
    registry.install(tools.childExtension);
    const persistence = new MemoryAgentPersistence();
    const { storage } = (await persistence.openOrb("tools", false))._unsafeUnwrap();
    let harness = await Harness.open(storage, { models, registry }, context);
    try {
      let root = await harness.root(context, {
        agent: {
          model: { provider: "faux", modelId: "faux-1" },
          instructions: "inherited",
          cwd: "/shared",
          modelTools: tools.modelTools,
          extensions: { remove: [tools.childExtension] },
        },
      });
      harness.resume();
      const submission = await root.submit({ type: "input", content: "go" }, context);
      await childStarted;
      await submission.wait(context);
      const graph = await harness.taskGraph(context);
      expect(Object.keys(graph.value.tasks).length).toBeGreaterThan(0);
      graph.dispose();
      const page = await storage.scanConversations({}, 100, undefined, context);
      expect(page.items.filter((c) => c.owner)).toHaveLength(1);
      const receipts = await harness.snapshot(ChildReceipts, root.id, context);
      expect(Object.keys(receipts?.children ?? {})).toHaveLength(1);
      expect(
        (await root.entries({}, 100, undefined, context)).items.filter(
          (entry) => entry.kind === "orb.subagent-task",
        ),
      ).toHaveLength(1);
      await harness.close(context);
      harness = await Harness.open(
        (await persistence.openOrb("tools", true))._unsafeUnwrap().storage,
        { models, registry },
        context,
      );
      root = await harness.root(context);
      expect(await harness.snapshot(ChildReceipts, root.id, context)).toEqual(receipts);
      harness.resume();
      await root.abort(context, { background: true });
      expect((await harness.inspect(context)).tasks).toHaveLength(0);
      expect(await harness.snapshot(ChildReceipts, root.id, context)).toEqual(receipts);
      expect(
        (await storage.scanConversations({}, 100, undefined, context)).items.filter((c) => c.owner),
      ).toHaveLength(1);
      expect(parentCalls).toBe(1);
    } finally {
      release();
      await harness.close(context);
      await tools.close();
      await persistence.close();
    }
  });
});

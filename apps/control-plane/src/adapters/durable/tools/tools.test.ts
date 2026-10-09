import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
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
import { CallableCatalog } from "./catalog.ts";
import { createDurableTools } from "./index.ts";

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
        return { content: [{ type: "text", text: value }] };
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
            return { content: [] };
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
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("codemode", {
          code: 'const r = await tools.echo({value:"ok"}); text(r); image({type:"image",data:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jg9sAAAAASUVORK5CYII=",mimeType:"image/png"});',
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
          execute: async ({ value }) => ({ content: [{ type: "text", text: value }] }),
        }),
      ],
      authorize: () => okAsync(undefined),
    });
    const registry = createRegistry();
    registry.install(tools.extension);
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
    try {
      const root = await harness.root(context, {
        agent: { model: { provider: "faux", modelId: "faux-1" } },
      });
      harness.resume();
      await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
      const entries = await root.entries({}, 100, undefined, context);
      const result = entries.items
        .flatMap((e) => e.model ?? [])
        .find((m) => m.role === "toolResult");
      expect(result?.content).toContainEqual({ type: "text", text: "ok" });
      expect(result?.content).toContainEqual({
        type: "image",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jg9sAAAAASUVORK5CYII=",
        mimeType: "image/png",
      });
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
    const respond = async (request: { messages: readonly unknown[] }) => {
      if (
        JSON.stringify(request.messages).includes('"child"') &&
        !JSON.stringify(request.messages).includes('"toolResult"')
      ) {
        entered();
        await blocked;
        return fauxAssistantMessage("child result");
      }
      return fauxAssistantMessage("parent done");
    };
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("subagent", { prompt: "child" }), {
        stopReason: "toolUse",
      }),
      respond,
      respond,
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const tools = createDurableTools();
    const registry = createRegistry();
    registry.install(tools.extension);
    const storage = new MemoryStorage();
    const harness = await Harness.open(storage, { models, registry }, context);
    try {
      const root = await harness.root(context, {
        agent: {
          model: { provider: "faux", modelId: "faux-1" },
          instructions: "inherited",
          cwd: "/shared",
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
      release();
      await root.abort(context, { background: true });
      expect((await harness.inspect(context)).tasks).toHaveLength(0);
    } finally {
      release();
      await harness.close(context);
      await tools.close();
    }
  });
});

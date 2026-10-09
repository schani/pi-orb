import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { ChildReceipts, createDurableTools } from "./index.ts";

const ctx = BACKGROUND_CONTEXT;
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function setup(responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]) {
  const faux = fauxProvider();
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const tools = createDurableTools();
  const registry = createRegistry();
  registry.install(tools.extension);
  return { models, registry, tools };
}
const initial = {
  agent: {
    model: { provider: "faux", modelId: "faux-1" },
    instructions: "shared instructions",
    cwd: "/shared",
  },
};

it("cancels only the selected child; root abort drains its sibling", async () => {
  const startedA = barrier(),
    startedB = barrier();
  const respond: FauxResponseFactory = async (request, options) => {
    const user = request.messages.find((m) => m.role === "user");
    const text = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content);
    if (text?.includes("child-a") || text?.includes("child-b")) {
      (text.includes("child-a") ? startedA : startedB).resolve();
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) resolve();
        else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return fauxAssistantMessage("", { stopReason: "aborted" });
    }
    const results = request.messages.filter((m) => m.role === "toolResult");
    if (results.length === 2) {
      await Promise.all([startedA.promise, startedB.promise]);
      const raw = results[0]?.content[0];
      const id = JSON.parse(raw?.type === "text" ? raw.text : "{}").agent_id;
      return fauxAssistantMessage(fauxToolCall("cancel_subagent", { agent_id: id }), {
        stopReason: "toolUse",
      });
    }
    return fauxAssistantMessage("parent done");
  };
  const s = setup([
    fauxAssistantMessage(
      [
        fauxToolCall("subagent", { prompt: "child-a" }, { id: "a" }),
        fauxToolCall("subagent", { prompt: "child-b" }, { id: "b" }),
      ],
      { stopReason: "toolUse" },
    ),
    ...Array(5).fill(respond),
  ]);
  const harness = await Harness.open(new MemoryStorage(), s, ctx);
  try {
    const root = await harness.root(ctx, initial);
    harness.resume();
    await (await root.submit({ type: "input", content: "parent" }, ctx)).wait(ctx);
    const entries = await root.entries({}, 100, undefined, ctx);
    expect(JSON.stringify(entries.items)).toContain('\\"status\\":\\"aborted\\"');
    const inspection = await harness.inspect(ctx);
    expect(inspection.tasks.filter((t) => t.record.kind === "orb.child")).toHaveLength(1);
    await root.abort(ctx, { background: true });
    expect((await harness.inspect(ctx)).tasks).toHaveLength(0);
  } finally {
    await harness.close(ctx);
    await s.tools.close();
  }
});

it("reopens persisted anchors without recreating children or rerunning the spawning tool", async () => {
  const childStarted = barrier();
  const respond: FauxResponseFactory = async (request, options) => {
    if (
      JSON.stringify(request.messages).includes('"child"') &&
      !request.messages.some((m) => m.role === "toolResult")
    ) {
      childStarted.resolve();
      await new Promise<void>((resolve) =>
        options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
      return fauxAssistantMessage("", { stopReason: "aborted" });
    }
    return fauxAssistantMessage("parent done");
  };
  const s = setup([
    fauxAssistantMessage(fauxToolCall("subagent", { prompt: "child" }), { stopReason: "toolUse" }),
    respond,
    respond,
  ]);
  const backing = new MemoryStorage();
  // Close the scheduler while preserving the committed backend, as reopening an on-disk store does.
  const storage = new Proxy(backing, {
    get(target, key) {
      if (key === "close") return async () => {};
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Storage;
  let harness = await Harness.open(storage, s, ctx);
  try {
    const root = await harness.root(ctx, initial);
    harness.resume();
    await (await root.submit({ type: "input", content: "parent" }, ctx)).wait(ctx);
    await childStarted.promise;
    const before = await harness.snapshot(ChildReceipts, root.id, ctx);
    expect(Object.keys(before?.children ?? {})).toHaveLength(1);
    await harness.close(ctx);
    const recovered = setup([fauxAssistantMessage("recovered child")]);
    harness = await Harness.open(storage, recovered, ctx);
    const reopened = await harness.root(ctx);
    harness.resume();
    const anchor = Object.values(before?.children ?? {})[0];
    expect(anchor).toBeDefined();
    if (!anchor) return;
    await harness.waitForTask(anchor.anchor as never, ctx);
    expect(await harness.snapshot(ChildReceipts, reopened.id, ctx)).toEqual(before);
    expect(
      (await storage.scanConversations({}, 100, undefined, ctx)).items.filter((c) => c.owner),
    ).toHaveLength(1);
    const record = await storage.task(anchor.anchor as never, ctx);
    expect(JSON.stringify(record)).toContain("recovered child");
    await recovered.tools.close();
  } finally {
    await harness.close(ctx);
    await s.tools.close();
    await backing.close(ctx);
  }
});

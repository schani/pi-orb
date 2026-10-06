import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { createDurableTools } from "./index.ts";

const ctx = BACKGROUND_CONTEXT;
it("steers an inherited child, waits for its persistent receipt and lists it", async () => {
  let release!: () => void;
  const steered = new Promise<void>((r) => {
    release = r;
  });
  let entered!: () => void;
  const childStarted = new Promise<void>((r) => {
    entered = r;
  });
  let id = "";
  const respond: FauxResponseFactory = async (request) => {
    const firstUser = request.messages.find((m) => m.role === "user");
    if (JSON.stringify(firstUser?.content).includes("child")) {
      if (JSON.stringify(request.messages).includes("refinement"))
        return fauxAssistantMessage("steered answer");
      entered();
      await steered;
      return fauxAssistantMessage("initial answer");
    }
    const last = request.messages.filter((m) => m.role === "toolResult").at(-1);
    if (last?.toolName === "subagent") {
      const text = last.content[0];
      id = JSON.parse(text?.type === "text" ? text.text : "{}").agent_id;
      await childStarted;
      return fauxAssistantMessage(
        fauxToolCall("steer_subagent", { agent_id: id, message: "refinement" }),
        { stopReason: "toolUse" },
      );
    }
    if (last?.toolName === "steer_subagent")
      return fauxAssistantMessage(
        fauxToolCall("get_subagent_result", { agent_id: id, wait: true }),
        { stopReason: "toolUse" },
      );
    if (last?.toolName === "get_subagent_result")
      return fauxAssistantMessage(fauxToolCall("list_subagents", {}), { stopReason: "toolUse" });
    return fauxAssistantMessage("done");
  };
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("subagent", { prompt: "child", description: "child description" }),
      { stopReason: "toolUse" },
    ),
    ...Array(7).fill(respond),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const tools = createDurableTools();
  const registry = createRegistry();
  registry.install(tools.extension);
  const storage = new MemoryStorage();
  const harness = await Harness.open(storage, { models, registry }, ctx);
  const unsubscribe = harness.subscribeCommits((publication) => {
    if (
      publication.changes.some(
        (c) => c.type === "submission" && c.value.requestId?.startsWith("steer:"),
      )
    )
      release();
  });
  try {
    const root = await harness.root(ctx, {
      agent: {
        model: { provider: "faux", modelId: "faux-1" },
        instructions: "root instructions",
        cwd: "/shared",
      },
    });
    harness.resume();
    await (await root.submit({ type: "input", content: "parent" }, ctx)).wait(ctx);
    const entries = await root.entries({}, 100, undefined, ctx);
    expect(JSON.stringify(entries.items)).toContain("steered answer");
    expect(JSON.stringify(entries.items)).toContain("child description");
    const record = (await storage.scanConversations({}, 100, undefined, ctx)).items.find(
      (c) => c.owner,
    );
    expect(record).toBeDefined();
    if (!record) return;
    const child = await harness.conversation(record.id, ctx);
    expect(await child?.agent(ctx)).toMatchObject({
      instructions: "root instructions",
      cwd: "/shared",
      model: { provider: "faux", modelId: "faux-1" },
    });
    expect((await harness.inspect(ctx)).tasks).toHaveLength(0);
  } finally {
    release();
    unsubscribe();
    await harness.close(ctx);
    await tools.close();
  }
});

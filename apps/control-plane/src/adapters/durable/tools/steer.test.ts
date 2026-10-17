import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage, type TaskId } from "@earendil-works/pi-durable";
import { okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { ChildReceipts, createDurableTools } from "./index.ts";

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
  const scripts = [
    'const child = JSON.parse(await tools.subagent({prompt:"child",description:"child description"})); store("child",child.agent_id); text("spawn:"+JSON.stringify(child));',
    'text("steer:"+JSON.stringify(JSON.parse(await tools.steer_subagent({agent_id:load("child"),message:"refinement"}))));',
    'text("result:"+JSON.stringify(JSON.parse(await tools.get_subagent_result({agent_id:load("child"),wait:true}))));',
    'text("list:"+JSON.stringify(JSON.parse(await tools.list_subagents({}))));',
  ];
  let rootCalls = 0;
  let childCalls = 0;
  const offered: string[][] = [];
  const respond: FauxResponseFactory = async (request) => {
    const names = new Set<string>();
    for (const message of request.messages)
      if (message.role === "system") {
        for (const tool of message.toolsRemoved ?? []) names.delete(tool.name);
        for (const tool of message.toolsAdded ?? []) names.add(tool.name);
      }
    offered.push([...names]);
    const firstUser = request.messages.find((m) => m.role === "user");
    if (JSON.stringify(firstUser?.content).includes('"child"')) {
      childCalls++;
      if (JSON.stringify(request.messages).includes("refinement"))
        return fauxAssistantMessage("steered answer");
      entered();
      await steered;
      return fauxAssistantMessage("initial answer");
    }
    const phase = rootCalls++;
    if (phase === 1) await childStarted;
    const code = scripts[phase];
    return code
      ? fauxAssistantMessage(fauxToolCall("codemode", { code }, { id: `phase-${phase}` }), {
          stopReason: "toolUse",
        })
      : fauxAssistantMessage("done");
  };
  const faux = fauxProvider();
  faux.setResponses(Array(7).fill(respond));
  const models = createModels();
  models.setProvider(faux.provider);
  const authorizations: string[] = [];
  const tools = createDurableTools({
    authorize: (name) => {
      authorizations.push(name);
      return okAsync(undefined);
    },
  });
  const registry = createRegistry();
  registry.install(tools.extension);
  registry.install(tools.childExtension);
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
        modelTools: tools.modelTools,
        extensions: { remove: [tools.childExtension] },
      },
    });
    harness.resume();
    await (await root.submit({ type: "input", content: "parent" }, ctx)).wait(ctx);
    const entries = await root.entries({}, 100, undefined, ctx);
    expect(JSON.stringify(entries.items)).toContain("steered answer");
    expect(JSON.stringify(entries.items)).toContain("child description");
    const results = entries.items
      .flatMap((entry) => entry.model ?? [])
      .filter((message) => message.role === "toolResult")
      .reverse();
    expect(results).toHaveLength(4);
    const outputs = results.map((result, index) => {
      expect(result).toMatchObject({ toolName: "codemode", isError: false });
      const prefix = ["spawn:", "steer:", "result:", "list:"][index]!;
      const lines = result.content
        .flatMap((block) => (block.type === "text" ? block.text.split("\n") : []))
        .filter((line) => line.startsWith(prefix));
      expect(lines).toHaveLength(1);
      return JSON.parse(lines[0]!.slice(prefix.length));
    });
    const id = outputs[0].agent_id;
    expect(id).toEqual(expect.any(String));
    expect(outputs[1]).toEqual({ agent_id: id, status: "accepted" });
    expect(outputs[2]).toEqual({
      agent_id: id,
      description: "child description",
      status: "completed",
      receipt: {
        status: "completed",
        result: { output: expect.stringContaining("steered answer") },
      },
    });
    expect(outputs[3]).toEqual([outputs[2]]);
    const receipts = await harness.snapshot(ChildReceipts, root.id, ctx);
    expect(Object.keys(receipts?.children ?? {})).toEqual([id]);
    const receipt = receipts!.children[id]!;
    expect(receipt).toMatchObject({ prompt: "child", description: "child description" });
    expect((await harness.getTask(receipt.anchor as TaskId, ctx))?.state).toMatchObject({
      status: "terminal",
      outcome: outputs[2].receipt,
    });
    expect(entries.items.filter((entry) => entry.kind === "orb.subagent-task")).toHaveLength(1);
    const records = (await storage.scanConversations({}, 100, undefined, ctx)).items.filter(
      (c) => c.owner,
    );
    expect(records).toHaveLength(1);
    const record = records[0]!;
    const child = await harness.conversation(record.id, ctx);
    expect(await child?.agent(ctx)).toMatchObject({
      instructions: "root instructions",
      cwd: "/shared",
      model: { provider: "faux", modelId: "faux-1" },
    });
    const childEntries = await child!.entries({}, 100, undefined, ctx);
    expect(
      childEntries.items
        .flatMap((entry) => entry.model ?? [])
        .filter((message) => message.role === "assistant")
        .flatMap((message) => message.content)
        .filter((block) => block.type === "text" && block.text === "steered answer"),
    ).toHaveLength(1);
    expect(rootCalls).toBe(5);
    expect(childCalls).toBe(2);
    expect(offered).toEqual(Array(7).fill(["codemode"]));
    expect(authorizations).toEqual([
      "subagent",
      "steer_subagent",
      "get_subagent_result",
      "list_subagents",
    ]);
    expect((await harness.inspect(ctx)).tasks).toHaveLength(0);
  } finally {
    release();
    unsubscribe();
    await harness.close(ctx);
    await tools.close();
  }
});

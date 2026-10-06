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

it("offers only code-mode in root and child requests while retaining internal tools/tasks", async () => {
  const bundle = createDurableTools();
  const registry = createRegistry();
  registry.install(bundle.extension);
  const faux = fauxProvider();
  const offered: string[][] = [];
  const respond: FauxResponseFactory = async (request) => {
    const names = new Set<string>();
    for (const message of request.messages)
      if (message.role === "system") {
        for (const tool of message.toolsAdded ?? []) names.add(tool.name);
        for (const tool of message.toolsRemoved ?? []) names.delete(tool.name);
      }
    offered.push([...names]);
    const user = request.messages.find((m) => m.role === "user");
    if (JSON.stringify(user?.content).includes("child"))
      return fauxAssistantMessage("child complete");
    if (!request.messages.some((m) => m.role === "toolResult"))
      return fauxAssistantMessage(
        fauxToolCall("codemode", { code: 'text(await tools.subagent({prompt:"child"}));' }),
        { stopReason: "toolUse" },
      );
    return fauxAssistantMessage("root complete");
  };
  faux.setResponses(Array(4).fill(respond));
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
  try {
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: "faux", modelId: "faux-1" }, tools: bundle.modelTools },
    });
    harness.resume();
    await (await root.submit({ type: "input", content: "start" }, BACKGROUND_CONTEXT)).wait(
      BACKGROUND_CONTEXT,
    );
    await root.abort(BACKGROUND_CONTEXT, { background: true });
    expect(offered.length).toBeGreaterThanOrEqual(2);
    expect(offered.every((names) => names.length === 1 && names[0] === "codemode")).toBe(true);
    expect(bundle.catalog.definitions().map((t) => t.name)).toContain("subagent");
    expect(bundle.catalog.definitions().map((t) => t.name)).not.toContain("codemode");
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
    await bundle.close();
  }
});

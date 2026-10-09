import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, MemoryStorage, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { expect, it } from "vitest";
import { DurableAgent } from "./agent.ts";
import { createDurableTools } from "./tools/index.ts";

it("persists only-mode model visibility while retaining the internal registry", async () => {
  const storage = new MemoryStorage();
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const tools = createDurableTools();
  const registry = createRegistry();
  registry.install(tools.extension);
  const opened = await DurableAgent.open({
    orbId: "orb",
    storage,
    models,
    registry,
    env: new NodeExecutionEnv({ cwd: "/tmp" }),
    checkoutCommit: null,
    instructions: "test",
    modelTools: tools.modelTools,
    initialSettings: { model: { provider: "faux", id: "faux-1" }, thinkingLevel: "off" },
  });
  expect(opened.isOk(), JSON.stringify(opened)).toBe(true);
  const agent = opened._unsafeUnwrap();
  try {
    const docs = await storage.scanDocuments(
      { scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID }, at: "current" },
      100,
      undefined,
      BACKGROUND_CONTEXT,
    );
    const record = docs.items.find((doc) => doc.kind === "pi.agent");
    expect(record).toBeDefined();
    const document = await storage.document(record!.id, "current", BACKGROUND_CONTEXT);
    expect(document?.value.tools).toEqual(["codemode"]);
  } finally {
    await agent.close();
    await tools.close();
  }
});

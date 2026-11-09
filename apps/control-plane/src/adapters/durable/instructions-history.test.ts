import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { expect, it } from "vitest";
import { DurableAgent, type DurableAgentOptions } from "./agent.ts";
import { MemoryAgentPersistence } from "./memory-persistence.testkit.ts";

it("writes no instruction history when instructions change across reopen", async () => {
  const authority = new MemoryAgentPersistence();
  const models = createModels();
  models.setProvider(fauxProvider({ models: [{ id: "one" }] }).provider);
  const open = async (revision: number, content: string) => {
    const storage = (await authority.openOrb("orb", false))._unsafeUnwrap().storage;
    const options = {
      orbId: "orb",
      storage,
      models,
      registry: createRegistry(),
      env: new NodeExecutionEnv({ cwd: "/tmp" }),
      checkoutCommit: "commit",
      instructions: content,
      initialSettings: { model: { provider: "faux", id: "one" }, thinkingLevel: "off" },
    } satisfies DurableAgentOptions;
    return (await DurableAgent.open(options))._unsafeUnwrap();
  };
  let agent = await open(0, "");
  const history = async () => (await agent.pullHistory(null, 100))._unsafeUnwrap().records;
  try {
    const initial = await history();
    expect(initial).toHaveLength(2);
    await agent.close();
    agent = await open(1, "PRIVATE_INSTRUCTION");
    expect(await history()).toEqual(initial);
    await agent.close();
    agent = await open(2, "");
    expect(await history()).toEqual(initial);
  } finally {
    await agent.close();
    await authority.close();
  }
});

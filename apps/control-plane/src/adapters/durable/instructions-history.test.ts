import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { expect, it } from "vitest";
import { DurableAgent, type DurableAgentOptions } from "./agent.ts";
import { MemoryAgentPersistence } from "./memory-persistence.testkit.ts";

it("records private instruction adoption edges once across reopen, including clearing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "instruction-history-"));
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
      instructionSnapshots: { personal: { revision, content }, project: { revision, content } },
      initialSettings: { model: { provider: "faux", id: "one" }, thinkingLevel: "off" },
    } satisfies DurableAgentOptions;
    return (await DurableAgent.open(options))._unsafeUnwrap();
  };
  let agent = await open(0, "");
  const history = async () => (await agent.pullHistory(null, 100))._unsafeUnwrap().records;
  try {
    expect(await history()).toHaveLength(2);
    await agent.close();
    agent = await open(1, "PRIVATE_INSTRUCTION");
    const adopted = await history();
    expect(adopted).toHaveLength(4);
    expect(JSON.stringify(adopted)).toContain("pi-orb:personal-instructions");
    expect(JSON.stringify(adopted)).toContain("pi-orb:project-instructions");
    expect(JSON.stringify(adopted)).not.toContain("PRIVATE_INSTRUCTION");
    expect(adopted.slice(2)).toMatchObject([
      {
        overflow: { native: { customType: "pi-orb:personal-instructions", data: { revision: 1 } } },
      },
      {
        overflow: { native: { customType: "pi-orb:project-instructions", data: { revision: 1 } } },
      },
    ]);
    await agent.close();
    agent = await open(1, "PRIVATE_INSTRUCTION");
    expect(await history()).toEqual(adopted);
    await agent.close();
    agent = await open(2, "");
    const cleared = await history();
    expect(cleared).toHaveLength(6);
    expect(cleared.slice(0, 4)).toEqual(adopted);
    expect(cleared.slice(4)).toMatchObject([
      { overflow: { native: { data: { revision: 2 } } } },
      { overflow: { native: { data: { revision: 2 } } } },
    ]);
  } finally {
    await agent.close();
    await authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

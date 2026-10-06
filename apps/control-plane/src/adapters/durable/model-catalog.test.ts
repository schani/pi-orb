import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { okAsync } from "neverthrow";
import { assert, describe, expect, it } from "vitest";
import { DurableAgent } from "./agent.ts";
import { MemoryAgentPersistence } from "./memory-persistence.testkit.ts";
import { createDurableModels } from "./models.ts";

async function models() {
  return (
    await createDurableModels({
      token: () => okAsync({ accessToken: "catalog-only", expiresAt: Date.now() + 3600000 }),
    })
  )._unsafeUnwrap();
}

describe("Durable public model catalog", () => {
  it("offers the four shared friendly aliases with canonical IDs and SDK capabilities", async () => {
    const runtime = await models();
    const agent = (
      await DurableAgent.open({
        orbId: "catalog",
        storage: new MemoryStorage(),
        models: runtime,
        registry: createRegistry(),
        env: new NodeExecutionEnv({ cwd: "/tmp" }),
        checkoutCommit: "commit",
        instructions: "",
      })
    )._unsafeUnwrap();
    try {
      const settings = agent.snapshot()._unsafeUnwrap().settings;
      assert(settings);
      expect(settings.models.map(({ name }) => name)).toEqual(["Astra", "Sol", "Terra", "Luna"]);
      expect(settings?.models.map(({ provider, id }) => ({ provider, id }))).toEqual([
        { provider: "openai-codex", id: "gpt-6-astra" },
        { provider: "openai-codex", id: "gpt-6.1-sol" },
        { provider: "openai-codex", id: "gpt-5.6-terra" },
        { provider: "openai-codex", id: "gpt-6-luna" },
      ]);
      for (const option of settings?.models ?? []) {
        const model = runtime.getModel(option.provider, option.id);
        expect(model?.input).toContain("image");
        assert(model);
        expect(option.thinkingLevels).toEqual(getSupportedThinkingLevels(model));
      }
      expect(settings?.settings).toEqual({
        model: { provider: "openai-codex", id: "gpt-6.1-sol" },
        thinkingLevel: "high",
      });
      const sol = settings.models[1];
      assert(sol);
      expect(
        (await agent.request("sol", { type: "set_model", model: sol }))._unsafeUnwrap(),
      ).toMatchObject({
        type: "settings_applied",
      });
      expect(agent.snapshot()._unsafeUnwrap().settings?.settings.model).toEqual({
        provider: sol.provider,
        id: sol.id,
      });
      // The public catalog does not prune the inference registry or rename model IDs.
      expect(runtime.getModel("openai-codex", "gpt-6-sol")?.name).toBe("GPT-6 Sol");
    } finally {
      await agent.close();
    }
  });

  it("restores an older saved canonical selection without resolving it to the current alias", async () => {
    const runtime = await models();
    const directory = await mkdtemp(join(tmpdir(), "durable-catalog-"));
    const authority = new MemoryAgentPersistence();
    const open = async (id: string) =>
      DurableAgent.open({
        orbId: "saved-catalog",
        storage: (await authority.openOrb("saved-catalog", false))._unsafeUnwrap().storage,
        models: runtime,
        registry: createRegistry(),
        env: new NodeExecutionEnv({ cwd: "/tmp" }),
        checkoutCommit: "commit",
        instructions: "",
        initialSettings: { model: { provider: "openai-codex", id }, thinkingLevel: "high" },
      });
    const original = (await open("gpt-6-sol"))._unsafeUnwrap();
    await original.close();
    const resumed = (await open("gpt-6-astra"))._unsafeUnwrap();
    try {
      const settings = resumed.snapshot()._unsafeUnwrap().settings;
      expect(settings?.settings.model).toEqual({ provider: "openai-codex", id: "gpt-6-sol" });
      expect(settings?.models.map(({ name }) => name)).toEqual(["Astra", "Sol", "Terra", "Luna"]);
      expect(settings?.models.find(({ name }) => name === "Sol")?.id).toBe("gpt-6.1-sol");
    } finally {
      await resumed.close();
      await authority.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

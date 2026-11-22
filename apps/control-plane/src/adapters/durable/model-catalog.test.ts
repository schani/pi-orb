import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { okAsync } from "neverthrow";
import { assert, describe, expect, it, vi } from "vitest";
import { DurableAgent, type DurableAgentOptions } from "./agent.ts";
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
    const availability = vi.spyOn(runtime, "getAvailable").mockResolvedValue([]);
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
    availability.mockRestore();
    try {
      const settings = agent.snapshot()._unsafeUnwrap().settings;
      assert(settings);
      expect(settings.models.map(({ name }) => name)).toEqual(["Astra", "Sol", "Terra", "Luna"]);
      expect(settings?.models.map(({ provider, id }) => ({ provider, id }))).toEqual([
        { provider: "openai-codex", id: "gpt-6.2-astra" },
        { provider: "openai-codex", id: "gpt-6.2-sol" },
        { provider: "openai-codex", id: "gpt-6.1-terra" },
        { provider: "openai-codex", id: "gpt-6-luna" },
      ]);
      for (const option of settings?.models ?? []) {
        const model = runtime.getModel(option.provider, option.id);
        expect(model?.input).toContain("image");
        assert(model);
        expect(option.thinkingLevels).toEqual(getSupportedThinkingLevels(model));
      }
      expect(settings?.settings).toEqual({
        model: { provider: "openai-codex", id: "gpt-6.2-sol" },
        thinkingLevel: "high",
      });
      const terra = settings.models.find(({ name }) => name === "Terra");
      assert(terra);
      expect(
        (await agent.request("terra", { type: "set_model", model: terra }))._unsafeUnwrap(),
      ).toMatchObject({
        type: "settings_applied",
      });
      expect(agent.snapshot()._unsafeUnwrap().settings?.settings.model).toEqual({
        provider: terra.provider,
        id: terra.id,
      });
      // The public catalog does not prune the inference registry or rename model IDs.
      expect(runtime.getModel("openai-codex", "gpt-5.6-terra")?.name).toBe("GPT-5.6 Terra");
    } finally {
      await agent.close();
    }
  });

  it("restores an older saved canonical selection without resolving it to the current alias", async () => {
    const runtime = await models();
    const authority = new MemoryAgentPersistence();
    const open = async (id: string, storage?: DurableAgentOptions["storage"]) =>
      DurableAgent.open({
        orbId: "saved-catalog",
        storage:
          storage ?? (await authority.openOrb("saved-catalog", false))._unsafeUnwrap().storage,
        models: runtime,
        registry: createRegistry(),
        env: new NodeExecutionEnv({ cwd: "/tmp" }),
        checkoutCommit: "commit",
        instructions: "",
        initialSettings: { model: { provider: "openai-codex", id }, thinkingLevel: "high" },
      });
    const original = (await open("gpt-5.6-terra"))._unsafeUnwrap();
    expect(original.snapshot()._unsafeUnwrap().settings?.settings.model).toEqual({
      provider: "openai-codex",
      id: "gpt-5.6-terra",
    });
    await original.close();
    const resumed = (await open("removed-initial-intent"))._unsafeUnwrap();
    try {
      const settings = resumed.snapshot()._unsafeUnwrap().settings;
      expect(settings?.settings.model).toEqual({ provider: "openai-codex", id: "gpt-5.6-terra" });
      expect(settings?.models.map(({ name }) => name)).toEqual(["Astra", "Sol", "Terra", "Luna"]);
      expect(settings?.models.find(({ name }) => name === "Terra")?.id).toBe("gpt-6.1-terra");
      const stream = vi.spyOn(runtime, "streamSimple");
      const storage = new MemoryStorage();
      const fresh = (await open("removed-after-spawn", storage))._unsafeUnwrap();
      try {
        expect(fresh.snapshot()._unsafeUnwrap().settings?.settings.model.id).toBe(
          "removed-after-spawn",
        );
        (
          await fresh.deliver({
            baseUrl: "unused",
            messageId: "first",
            messageIds: ["first"],
            content: [{ type: "text", text: "work" }],
          })
        )._unsafeUnwrap();
        await fresh.waitForIdle();
        expect(
          (await storage.scanTasks({}, 100, undefined, BACKGROUND_CONTEXT)).items,
        ).toContainEqual(
          expect.objectContaining({
            state: expect.objectContaining({
              outcome: {
                status: "failed",
                error: {
                  message: "Model openai-codex/removed-after-spawn is not available",
                  detail: { reason: "no_model" },
                },
              },
            }),
          }),
        );
      } finally {
        await fresh.close();
      }
      expect(stream).not.toHaveBeenCalled();
    } finally {
      await resumed.close();
      await authority.close();
    }
  });
});

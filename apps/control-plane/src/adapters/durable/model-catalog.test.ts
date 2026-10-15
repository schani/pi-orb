import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { okAsync } from "neverthrow";
import { assert, describe, expect, it, vi } from "vitest";
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
    expect(original.snapshot()._unsafeUnwrap().settings?.settings.model).toEqual({
      provider: "openai-codex",
      id: "gpt-6-sol",
    });
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

it.each(["removed", "disconnected", "lookup-throws"] as const)(
  "rejects %s explicit initial model before readiness without inference",
  async (failure) => {
    const runtime = await models();
    const available = vi.spyOn(runtime, "getAvailable");
    if (failure === "disconnected") available.mockResolvedValue([]);
    if (failure === "lookup-throws") available.mockRejectedValue(new Error("credential-secret"));
    const stream = vi.spyOn(runtime, "streamSimple");
    const result = await DurableAgent.open({
      orbId: "unavailable-intent",
      storage: new MemoryStorage(),
      models: runtime,
      registry: createRegistry(),
      env: new NodeExecutionEnv({ cwd: "/tmp" }),
      checkoutCommit: "commit",
      instructions: "",
      initialSettings: {
        model: { provider: "openai-codex", id: failure === "removed" ? "removed" : "gpt-6-astra" },
        thinkingLevel: "high",
      },
    });
    if (result.isOk()) await result.value.close();
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "runtime_client_error",
      retryable: failure === "lookup-throws",
    });
    expect(result._unsafeUnwrapErr().message).not.toContain("credential-secret");
    expect(stream).not.toHaveBeenCalled();
  },
);

it("checks restored native model rather than an unavailable initial intent", async () => {
  const runtime = await models();
  const authority = new MemoryAgentPersistence();
  const open = async (id: string) =>
    DurableAgent.open({
      orbId: "restored-intent",
      storage: (await authority.openOrb("restored-intent", false))._unsafeUnwrap().storage,
      models: runtime,
      registry: createRegistry(),
      env: new NodeExecutionEnv({ cwd: "/tmp" }),
      checkoutCommit: "commit",
      instructions: "",
      initialSettings: { model: { provider: "openai-codex", id }, thinkingLevel: "high" },
    });
  try {
    const first = (await open("gpt-6.1-sol"))._unsafeUnwrap();
    await first.close();
    const resumed = (await open("removed-initial-intent"))._unsafeUnwrap();
    try {
      expect(resumed.snapshot()._unsafeUnwrap().settings?.settings.model.id).toBe("gpt-6.1-sol");
    } finally {
      await resumed.close();
    }
  } finally {
    await authority.close();
  }
});

it("keeps omitted default bootstrap available before owner login", async () => {
  const runtime = await models();
  vi.spyOn(runtime, "getAvailable").mockResolvedValue([]);
  const agent = (
    await DurableAgent.open({
      orbId: "login-bootstrap",
      storage: new MemoryStorage(),
      models: runtime,
      registry: createRegistry(),
      env: new NodeExecutionEnv({ cwd: "/tmp" }),
      checkoutCommit: "commit",
      instructions: "",
    })
  )._unsafeUnwrap();
  await agent.close();
});

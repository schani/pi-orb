import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { AgentSettingsEventSchema, type OrbView } from "@pi-orb/protocol";
import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { DurableAgent } from "../../../control-plane/src/adapters/durable/agent.ts";
import { MemoryAgentPersistence } from "../../../control-plane/src/adapters/durable/memory-persistence.testkit.ts";
import { canSendComposer, initialState } from "./OrbPage.tsx";

function barrier() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const input = {
  type: "message" as const,
  expectedHeadId: null,
  content: [{ type: "text" as const, text: "work" }],
};
const initialSettings = {
  model: { provider: "faux", id: "faux-1" },
  thinkingLevel: "off" as const,
};

describe("central facade composer contract", () => {
  it("accepts steering while busy and fresh input after reopening paused unfinished work", async () => {
    const directory = await mkdtemp(join(tmpdir(), "central-composer-"));
    const authority = new MemoryAgentPersistence();
    const entered = barrier();
    const provider = fauxProvider();
    provider.setResponses([
      (_request, options) =>
        new Promise((resolve) => {
          entered.resolve();
          options?.signal?.addEventListener(
            "abort",
            () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
            { once: true },
          );
        }),
    ]);
    const models = createModels();
    models.setProvider(provider.provider);
    const open = async (resume: boolean) =>
      (
        await DurableAgent.open({
          orbId: "orb",
          storage: (await authority.openOrb("orb", !resume))._unsafeUnwrap().storage,
          models,
          registry: createRegistry(),
          env: new NodeExecutionEnv({ cwd: directory }),
          checkoutCommit: "commit",
          instructions: "instruction",
          initialSettings,
          resume,
        })
      )._unsafeUnwrap();
    let agent = await open(true);
    const checkInput = (orb: OrbView) => {
      const snapshot = agent.snapshot()._unsafeUnwrap();
      const state = {
        ...initialState("orb"),
        historyLoaded: true,
        connection: "open" as const,
        synced: true,
        activity: snapshot.activity,
        settings: snapshot.settings ?? null,
      };
      expect(Check(AgentSettingsEventSchema, snapshot.settings)).toBe(true);
      expect(canSendComposer(orb, state)).toBe(true);
      expect(
        canSendComposer(
          { ...orb, centralAgent: false, state: "running" },
          {
            ...state,
            settings: {
              type: "agent_settings",
              settings: initialSettings,
              models: [],
              writable: false,
            },
          },
        ),
      ).toBe(false);
    };
    try {
      const accepted = (
        await agent.request("human", {
          ...input,
          expectedHeadId: agent.snapshot()._unsafeUnwrap().headId,
        })
      )._unsafeUnwrap();
      expect(accepted.type).toBe("accepted");
      await entered.promise;
      expect(agent.snapshot()._unsafeUnwrap().settings?.writable).toBe(false);
      checkInput({ state: "creating", centralAgent: true } as OrbView);
      (await agent.close())._unsafeUnwrap();
      agent = await open(false);
      checkInput({ state: "stopped", stopReason: "manual", centralAgent: true } as OrbView);
    } finally {
      await agent.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

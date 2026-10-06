import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, type StorageWrite } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { describe, expect, it } from "vitest";
import { DurableAgent } from "./agent.ts";
import { MemoryAgentPersistence } from "./memory-persistence.testkit.ts";

describe("Durable public settings history", () => {
  it("persists canonical initial and changed settings exactly once across replay and reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "settings-history-"));
    const authority = new MemoryAgentPersistence();
    const models = createModels();
    models.setProvider(
      fauxProvider({
        models: [
          { id: "one", reasoning: true },
          { id: "two", reasoning: true },
        ],
      }).provider,
    );
    const batches: StorageWrite[][] = [];
    const documentKinds = new Map<number, string>();
    const open = async () => {
      const storage = (await authority.openOrb("orb", false))._unsafeUnwrap().storage;
      const commit = storage.commit.bind(storage);
      storage.commit = async (writes, context) => {
        const sequence = await commit(writes, context);
        for (const write of writes)
          if (write.type === "document.create")
            documentKinds.set(write.record.id, write.record.kind);
        batches.push(structuredClone([...writes]));
        return sequence;
      };
      return (
        await DurableAgent.open({
          orbId: "orb",
          storage,
          models,
          registry: createRegistry(),
          env: new NodeExecutionEnv({ cwd: "/tmp" }),
          checkoutCommit: "commit",
          instructions: "PRIVATE instructions",
          initialSettings: { model: { provider: "faux", id: "one" }, thinkingLevel: "off" },
          now: () => 1000,
        })
      )._unsafeUnwrap();
    };
    const changedDocs = (writes: readonly StorageWrite[]) =>
      writes.flatMap((write) =>
        write.type === "document.create"
          ? [write.record.kind]
          : write.type === "document.change"
            ? [documentKinds.get(write.id)]
            : [],
      );
    let agent = await open();
    const history = async () => (await agent.pullHistory(null, 100))._unsafeUnwrap().records;
    const model = { type: "set_model" as const, model: { provider: "faux", id: "two" } };
    const thinking = { type: "set_thinking" as const, thinkingLevel: "high" as const };
    try {
      const initial = await history();
      expect(initial).toHaveLength(2);
      const initialBatch = batches.find((writes) =>
        writes.some((write) => write.type === "entry" && write.value.kind === "orb.model-change"),
      );
      expect(initialBatch).toBeDefined();
      expect(
        initialBatch?.filter((write) => write.type === "entry").map((write) => write.value.kind),
      ).toEqual(["orb.model-change", "orb.thinking-level-change"]);
      expect(changedDocs(initialBatch ?? [])).toContain("orb.identity");
      expect(JSON.stringify(initialBatch)).toContain("publicSettingsInitialized");
      expect(initial).toMatchObject([
        {
          type: "event",
          eventType: "pi.model_change",
          parentId: null,
          overflow: { native: { type: "model_change", provider: "faux", modelId: "one" } },
        },
        {
          type: "event",
          eventType: "pi.thinking_level_change",
          parentId: initial[0]?.id,
          overflow: { native: { type: "thinking_level_change", thinkingLevel: "off" } },
        },
      ]);
      expect((await agent.request("model", model))._unsafeUnwrap()).toEqual({
        type: "settings_applied",
        duplicate: false,
      });
      expect((await agent.request("thinking", thinking))._unsafeUnwrap()).toEqual({
        type: "settings_applied",
        duplicate: false,
      });
      for (const [kind, requestId] of [
        ["orb.model-change", "model"],
        ["orb.thinking-level-change", "thinking"],
      ]) {
        const batch = batches.findLast((writes) =>
          writes.some((write) => write.type === "entry" && write.value.kind === kind),
        );
        expect(batch).toBeDefined();
        expect(changedDocs(batch ?? [])).toEqual(
          expect.arrayContaining(["pi.agent", "orb.identity"]),
        );
        expect(JSON.stringify(batch)).toContain(requestId);
      }
      const changed = await history();
      expect(changed).toHaveLength(4);
      expect(changed.slice(0, 2)).toEqual(initial);
      expect(changed.slice(2)).toMatchObject([
        {
          eventType: "pi.model_change",
          parentId: initial[1]?.id,
          overflow: { native: { provider: "faux", modelId: "two" } },
        },
        {
          eventType: "pi.thinking_level_change",
          parentId: changed[2]?.id,
          overflow: { native: { thinkingLevel: "high" } },
        },
      ]);
      for (const record of changed) {
        const native = record.overflow["native"];
        expect(Object.keys(native as object).sort()).toEqual(
          record.type === "event" && record.eventType === "pi.model_change"
            ? ["id", "modelId", "parentId", "provider", "timestamp", "type"]
            : ["id", "parentId", "thinkingLevel", "timestamp", "type"],
        );
      }
      expect(JSON.stringify(changed)).not.toContain("PRIVATE");
      expect((await agent.request("thinking", thinking))._unsafeUnwrap()).toEqual({
        type: "settings_applied",
        duplicate: true,
      });
      await agent.close();
      agent = await open();
      expect(await history()).toEqual(changed);
      expect(agent.snapshot()._unsafeUnwrap().settings?.settings).toEqual({
        model: model.model,
        thinkingLevel: "high",
      });
      expect((await agent.request("model", model))._unsafeUnwrap()).toEqual({
        type: "settings_applied",
        duplicate: true,
      });
      expect((await agent.request("thinking", thinking))._unsafeUnwrap()).toEqual({
        type: "settings_applied",
        duplicate: true,
      });
      expect(await history()).toEqual(changed);
      expect((await agent.request("same-model", model))._unsafeUnwrap()).toEqual({
        type: "settings_applied",
        duplicate: false,
      });
      expect((await agent.request("same-thinking", thinking))._unsafeUnwrap()).toEqual({
        type: "settings_applied",
        duplicate: false,
      });
      expect(await history()).toEqual(changed);
    } finally {
      await agent.close();
      await authority.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

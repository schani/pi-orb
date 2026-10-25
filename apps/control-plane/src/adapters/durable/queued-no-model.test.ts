import assert from "node:assert/strict";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  type Harness,
  MemoryStorage,
  ROOT_CONVERSATION_ID,
  type StorageWrite,
  section,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { expect, it } from "vitest";
import { DurableAgent } from "./agent.ts";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each(["available", "missing"] as const)(
  "continues a no-model failure with %s next-model availability without replay or unbounded work",
  async (nextModel) => {
    const entered = barrier(),
      release = barrier();
    const settlements: string[] = [];
    class SettlementStorage extends MemoryStorage {
      override async commit(writes: readonly StorageWrite[], context: Context) {
        const seq = await super.commit(writes, context);
        for (const write of writes)
          if (write.type === "submission" && ["done", "unanswered"].includes(write.value.status))
            settlements.push(write.value.requestId ?? "missing-request-id");
        return seq;
      }
    }
    const storage = new SettlementStorage();
    const old = fauxProvider({ models: [{ id: "old" }] });
    const replacement = fauxProvider({ models: [{ id: "replacement" }] });
    replacement.setResponses([fauxAssistantMessage("queued answer")]);
    const models = createModels();
    models.setProvider(old.provider);
    const registry = createRegistry();
    let renders = 0;
    registry.install({
      name: "preparation-barrier",
      sections: [
        section("preparation-barrier", async () => {
          if (renders++ === 0) {
            entered.resolve();
            await release.promise;
          }
          return "fixture";
        }),
      ],
    });
    let conversation!: Harness["conversation"];
    const agent = (
      await DurableAgent.open({
        orbId: "no-model",
        storage,
        models,
        registry,
        env: new NodeExecutionEnv({ cwd: "/tmp" }),
        checkoutCommit: null,
        instructions: "",
        initialSettings: { model: { provider: "faux", id: "old" }, thinkingLevel: "off" },
        bindNativeConversation: (resolve) => {
          conversation = resolve;
        },
      })
    )._unsafeUnwrap();
    const input = (messageId: string) => ({
      baseUrl: "unused",
      messageId,
      messageIds: [messageId],
      content: [{ type: "text" as const, text: messageId }],
    });
    const submission = (id: string) =>
      storage.submissionByRequest(ROOT_CONVERSATION_ID, `inbox:${id}`, BACKGROUND_CONTEXT);
    try {
      (await agent.deliver(input("failed")))._unsafeUnwrap();
      await entered.promise;
      for (const id of ["queued-1", "queued-2"]) {
        (await agent.deliver(input(id)))._unsafeUnwrap();
        expect(await submission(id)).toMatchObject({ status: "queued" });
      }
      const root = await conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
      assert(root);
      // The prepared request stays pinned to the removed model; the next run uses the new selection.
      if (nextModel === "available")
        await root.configure(
          { model: { provider: "faux", modelId: "replacement" } },
          BACKGROUND_CONTEXT,
        );
      models.setProvider(replacement.provider);
      release.resolve();
      (await agent.waitForIdle())._unsafeUnwrap();
      const failed = await submission("failed");
      expect(failed).toMatchObject({ status: "unanswered", reason: "no_model" });
      for (const id of ["queued-1", "queued-2"])
        expect(await submission(id)).toMatchObject(
          nextModel === "available"
            ? { status: "done" }
            : { status: "unanswered", reason: "no_model" },
        );
      expect(old.state.callCount).toBe(0);
      expect(replacement.state.callCount).toBe(nextModel === "available" ? 1 : 0);
      const tasks = (await storage.scanTasks({}, 100, undefined, BACKGROUND_CONTEXT)).items;
      expect(tasks).toHaveLength(2);
      expect(tasks.every((task) => task.state.status === "terminal")).toBe(true);
      expect(
        tasks.flatMap((task) =>
          task.state.status === "terminal" && task.state.outcome.status === "failed"
            ? [task.state.outcome.error.detail]
            : [],
        ),
      ).toEqual(
        Array.from({ length: nextModel === "available" ? 1 : 2 }, () => ({ reason: "no_model" })),
      );
      const entries = await root.entries({}, 100, undefined, BACKGROUND_CONTEXT);
      expect(
        entries.items
          .filter((entry) => entry.kind === "pi.user")
          .map((entry) => (entry.model?.[0]?.role === "user" ? entry.model[0].content : null)),
      ).toEqual(["queued-2", "queued-1", "failed"].map((text) => [{ type: "text", text }]));
      for (const id of ["failed", "queued-1", "queued-2"])
        expect((await agent.deliver(input(id)))._unsafeUnwrap().duplicate).toBe(true);
      (await agent.waitForIdle())._unsafeUnwrap();
      expect(await submission("failed")).toEqual(failed);
      expect(settlements.toSorted()).toEqual(["inbox:failed", "inbox:queued-1", "inbox:queued-2"]);
      expect((await storage.scanTasks({}, 100, undefined, BACKGROUND_CONTEXT)).items).toEqual(
        tasks,
      );
    } finally {
      release.resolve();
      (await agent.close())._unsafeUnwrap();
    }
  },
);

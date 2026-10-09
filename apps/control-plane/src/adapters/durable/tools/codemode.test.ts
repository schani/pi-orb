import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type Conversation,
  createRegistry,
  defineTool,
  Harness,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { okAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { MemoryAgentPersistence } from "../memory-persistence.testkit.ts";
import { CallableCatalog } from "./catalog.ts";
import { codemodeTool } from "./codemode.ts";
import { createOrbTools } from "./orb-tools.ts";

const ctx = BACKGROUND_CONTEXT;
function api(conversation: Conversation): ToolExecutionApi {
  return {
    conversationId: conversation.id,
    commit: conversation.commit.bind(conversation),
    callId: "call",
  } as ToolExecutionApi;
}
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe("Durable code-mode store", () => {
  it("gives real nested native calls distinct stable request identities", async () => {
    const { MemoryStorage } = await import("@earendil-works/pi-durable");
    const harness = await Harness.open(
      new MemoryStorage(),
      { models: createModels(), registry: createRegistry() },
      ctx,
    );
    const requests: string[] = [];
    const tool = codemodeTool(
      new CallableCatalog(
        createOrbTools({
          invoke: (_action, requestId) => {
            requests.push(requestId);
            return okAsync({ accepted: true });
          },
        }),
      ),
      new Set(),
    );
    try {
      const root = await harness.root(ctx);
      const invocation = { ...api(root), taskId: 42, callId: "outer" } as ToolExecutionApi;
      const code = 'await tools.orb_spawn({prompt:"one"}); await tools.orb_spawn({prompt:"two"});';
      expect((await tool.execute({ code }, invocation, ctx)).isError).toBe(false);
      expect((await tool.execute({ code }, invocation, ctx)).isError).toBe(false);
      expect(requests).toEqual([
        '[42,"outer:nested:0"]',
        '[42,"outer:nested:1"]',
        '[42,"outer:nested:0"]',
        '[42,"outer:nested:1"]',
      ]);
    } finally {
      await harness.close(ctx);
    }
  });
  it("persists successful writes and deletions through reopen, isolating conversations", async () => {
    const authority = new MemoryAgentPersistence();
    const tool = codemodeTool(new CallableCatalog([]), new Set());
    const open = async () =>
      Harness.open(
        (await authority.openOrb("orb", false))._unsafeUnwrap().storage,
        { models: createModels(), registry: createRegistry() },
        ctx,
      );
    let harness = await open();
    try {
      let root = await harness.root(ctx);
      const child = await harness.createConversation({ ownership: { kind: "ownerless" } }, ctx);
      expect(
        (
          await tool.execute(
            { code: 'store("kept", {n: 3}); store("deleted", 1);' },
            api(root),
            ctx,
          )
        ).isError,
      ).toBe(false);
      expect(
        (await tool.execute({ code: 'text(load("kept"));' }, api(child), ctx)).content,
      ).not.toContainEqual({ type: "text", text: '{"n":3}' });
      await harness.close(ctx);
      harness = await open();
      root = await harness.root(ctx);
      const loaded = await tool.execute(
        { code: 'text(load("kept")); store("deleted", undefined);' },
        api(root),
        ctx,
      );
      expect(loaded.content).toContainEqual({ type: "text", text: '{"n":3}' });
      await harness.close(ctx);
      harness = await open();
      root = await harness.root(ctx);
      expect(
        (await tool.execute({ code: 'text(load("deleted") === undefined);' }, api(root), ctx))
          .content,
      ).toContainEqual({ type: "text", text: "true" });
    } finally {
      await harness.close(ctx);
      await authority.close();
    }
  });

  it("does not persist failed script writes", async () => {
    const { MemoryStorage } = await import("@earendil-works/pi-durable");
    const harness = await Harness.open(
      new MemoryStorage(),
      { models: createModels(), registry: createRegistry() },
      ctx,
    );
    const tool = codemodeTool(new CallableCatalog([]), new Set());
    try {
      const root = await harness.root(ctx);
      await tool.execute({ code: 'store("key", "original");' }, api(root), ctx);
      expect(
        (
          await tool.execute(
            { code: 'store("key", "bad"); throw new Error("script");' },
            api(root),
            ctx,
          )
        ).isError,
      ).toBe(true);
      expect(
        (await tool.execute({ code: 'text(load("key"));' }, api(root), ctx)).content,
      ).toContainEqual({ type: "text", text: "original" });
    } finally {
      await harness.close(ctx);
    }
  });

  it("merges only changed keys from concurrent successful scripts", async () => {
    const { MemoryStorage } = await import("@earendil-works/pi-durable");
    const harness = await Harness.open(
      new MemoryStorage(),
      { models: createModels(), registry: createRegistry() },
      ctx,
    );
    const entered = latch();
    const release = latch();
    const tool = codemodeTool(
      new CallableCatalog([
        defineTool({
          name: "hold",
          description: "hold",
          parameters: Type.Object({}),
          execute: async () => {
            entered.resolve();
            await release.promise;
            return { content: [] };
          },
        }),
      ]),
      new Set(),
    );
    try {
      const root = await harness.root(ctx);
      const slow = tool.execute(
        { code: 'await tools.hold({}); store("slow", 1);' },
        api(root),
        ctx,
      );
      await entered.promise;
      await tool.execute({ code: 'store("fast", 2);' }, api(root), ctx);
      release.resolve();
      await slow;
      const result = await tool.execute(
        { code: 'text([load("fast"), load("slow")]);' },
        api(root),
        ctx,
      );
      expect(result.content).toContainEqual({ type: "text", text: "[2,1]" });
    } finally {
      release.resolve();
      await harness.close(ctx);
    }
  });
});

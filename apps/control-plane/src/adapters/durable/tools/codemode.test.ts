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
import { NoSimulationTask } from "determined";
import { okAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { MemoryAgentPersistence } from "../memory-persistence.testkit.ts";
import { CallableCatalog } from "./catalog.ts";
import { codemodeTool } from "./codemode.ts";
import { codeModeMemory } from "./codemode-memory.ts";
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
      const result = await tool.execute({ code }, invocation, ctx);
      expect(result.isError).toBe(false);
      expect(result.details).toMatchObject({ cpu: { budgetCores: 1 } });
      expect(Number((result.details as { cpu: { cpuMs: number } }).cpu.cpuMs)).toBeGreaterThan(0);
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

  it("tracks live workers and peak memory across concurrent success and resource failures", async () => {
    const { MemoryStorage } = await import("@earendil-works/pi-durable");
    const harness = await Harness.open(
      new MemoryStorage(),
      { models: createModels(), registry: createRegistry() },
      ctx,
    );
    const lines: string[] = [];
    const task = new (class extends NoSimulationTask {
      override log(...parts: readonly unknown[]) {
        lines.push(parts.join(" "));
      }
    })("codemode", false);
    let arrivals = 0;
    const arrived = latch();
    const release = latch();
    const tool = codemodeTool(
      new CallableCatalog([
        defineTool({
          name: "hold",
          description: "hold",
          parameters: Type.Object({}),
          execute: async () => {
            if (++arrivals === 2) arrived.resolve();
            await release.promise;
            return { content: [] };
          },
        }),
      ]),
      new Set(),
      {},
      { id: "orb-1", task },
    );
    const MiB = 1024 * 1024;
    const peak = (result: { details?: unknown }) =>
      (result.details as { memory: { peakBytes: number } }).memory.peakBytes;
    const baseline = codeModeMemory.active;
    try {
      const root = await harness.root(ctx);
      const holding = tool.execute(
        { code: "const b = new Uint8Array(32 * 1024 * 1024).fill(1); await tools.hold({});" },
        { ...api(root), callId: "holding" },
        ctx,
      );
      const exhausting = tool.execute(
        {
          code: "await tools.hold({}); const a = []; for (;;) a.push(new Uint8Array(16 * 1024 * 1024).fill(1));",
        },
        { ...api(root), callId: "exhausting" },
        ctx,
      );
      await arrived.promise;
      expect(codeModeMemory.active).toBe(baseline + 2);
      release.resolve();
      const [held, exhausted] = await Promise.all([holding, exhausting]);
      expect(codeModeMemory.active).toBe(baseline);
      expect(held.isError).toBe(false);
      expect(peak(held)).toBeGreaterThan(32 * MiB);
      expect(exhausted.isError).toBe(true);
      expect(peak(exhausted)).toBeGreaterThan(200 * MiB);
      const flooded = await tool.execute(
        { code: 'const s = "x".repeat(600 * 1024); text(s); text(s);' },
        { ...api(root), callId: "flooded" },
        ctx,
      );
      expect(flooded.isError).toBe(true);
      expect(codeModeMemory.active).toBe(baseline);
      expect(lines.map((line) => line.replace(/peak_mib=\d+/, "peak_mib=N"))).toEqual([
        `lifecycle: orb=orb-1 codemode.resource_failed kind=out_of_memory peak_mib=N conversation=${root.id} call=exhausting`,
        `lifecycle: orb=orb-1 codemode.resource_failed kind=output_limit peak_mib=N conversation=${root.id} call=flooded`,
      ]);
    } finally {
      release.resolve();
      await harness.close(ctx);
    }
  });
});

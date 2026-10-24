import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import {
  type ConversationId,
  type DocumentId,
  defineTool,
  type EntryId,
} from "@earendil-works/pi-durable";
import { CodemodeStoreDoc } from "@earendil-works/pi-durable/codemode";
import { NoSimulationTask } from "determined";
import { okAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { MemoryAgentPersistence } from "../memory-persistence.testkit.ts";
import { CallableCatalog } from "./catalog.ts";
import { codeModeMemory } from "./codemode-memory.ts";
import { createOrbTools } from "./orb-tools.ts";
import { openCodemodeHarness } from "./testkit/codemode.ts";

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const output = (value: { output?: unknown }) => JSON.stringify(value.output);
describe("Durable native code-mode store", () => {
  it("gives real native calls stable request identities and caches the decided result", async () => {
    const requests: string[] = [];
    const fixture = await openCodemodeHarness(
      new CallableCatalog(
        createOrbTools({
          invoke: (_action, requestId) => {
            requests.push(requestId);
            return okAsync({
              orbId: "orb",
              projectId: "project",
              messageId: "message",
              url: "url",
            });
          },
        }),
      ),
      { holdForReplay: true },
    );
    try {
      const result = await fixture.run(
        'await tools.orb_spawn({prompt:"one"}); await tools.orb_spawn({prompt:"two"});',
      );
      expect(result.isError).toBe(false);
      expect(result.details).toMatchObject({ cpu: { budgetCores: 1 } });
      expect(Number((result.details as { cpu: { cpuMs: number } }).cpu.cpuMs)).toBeGreaterThan(0);
      expect((await fixture.replay()).isError).toBe(false);
      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatch(/\/c1/);
      expect(requests[1]).toMatch(/\/c2/);
      expect(requests[0]).not.toBe(requests[1]);
    } finally {
      await fixture.close();
    }
  });

  it("persists successful writes and deletions through reopen, isolating conversations", async () => {
    const authority = new MemoryAgentPersistence();
    const open = async (orb: string) =>
      openCodemodeHarness(new CallableCatalog([]), {
        storage: (await authority.openOrb(orb, false))._unsafeUnwrap().storage,
      });
    let fixture = await open("store");
    try {
      expect((await fixture.run('store("kept",{n:3}); store("deleted",1);')).isError).toBe(false);
      const other = await fixture.harness.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent: { model: { provider: "faux", modelId: "faux-1" } },
        },
        BACKGROUND_CONTEXT,
      );
      expect(output(await fixture.run('text(load("kept") === undefined);', other))).toContain(
        "true",
      );
      await fixture.close();
      fixture = await open("store");
      expect(
        (await fixture.run('text(load("kept")); store("deleted",undefined);')).output,
      ).toContainEqual({ type: "text", text: '{"n":3}' });
      await fixture.close();
      fixture = await open("store");
      expect(output(await fixture.run('text(load("deleted") === undefined);'))).toContain("true");
    } finally {
      await fixture.close();
      await authority.close();
    }
  });

  it("reads a 1.3 store base/delta across the 64-delta checkpoint and as-of fork", async () => {
    const context = BACKGROUND_CONTEXT;
    const authority = new MemoryAgentPersistence();
    const storage = (await authority.openOrb("old-store", false))._unsafeUnwrap().storage;
    const root = 1 as ConversationId,
      store = 14 as DocumentId,
      marker = 19 as EntryId;
    // Essential logical records from the patched 1.3 store, without model/task history.
    await storage.commit(
      [
        { type: "conversation", value: { id: root } },
        {
          type: "document.create",
          record: {
            id: store,
            kind: "pi.codemode.store",
            scope: { kind: "conversation", conversationId: root },
            history: "rewindable",
            fork: "asOf",
          },
          content: { version: 1, kind: "base", value: { values: {} } },
        },
      ],
      context,
    );
    const saved = { version: "1.3.0", nested: [1, true, null] };
    await storage.commit(
      [
        {
          type: "document.change",
          id: store,
          content: {
            version: 1,
            kind: "delta",
            ops: [
              ["s", ["values", "counter"], 0],
              ["s", ["values", "old"], saved],
            ],
          },
        },
        {
          type: "entry",
          value: {
            id: marker,
            conversationId: root,
            kind: "fixture.marker",
            data: { counter: 0 },
          },
        },
      ],
      context,
    );
    let fixture = await openCodemodeHarness(new CallableCatalog([]), { storage });
    try {
      await fixture.root.configure({ model: { provider: "faux", modelId: "faux-1" } }, context);
      expect((await fixture.run('text(load("old"));')).output).toContainEqual({
        type: "text",
        text: JSON.stringify(saved),
      });
      for (let counter = 1; counter <= 63; counter++) {
        await fixture.root.commit(async (tx) => {
          (await tx.doc(CodemodeStoreDoc, root)).values.counter = counter;
        }, context);
      }
      expect((await storage.document(store, "current", context))?.deltasSinceBase).toBe(64);
      expect((await fixture.run('store("counter",64);')).isError).toBe(false);
      expect(await storage.document(store, "current", context)).toMatchObject({
        deltasSinceBase: 0,
        value: { values: { counter: 64, old: saved } },
      });
      await fixture.close();
      fixture = await openCodemodeHarness(new CallableCatalog([]), {
        storage: (await authority.openOrb("old-store", true))._unsafeUnwrap().storage,
      });
      expect((await fixture.run('text(load("old"));')).output).toContainEqual({
        type: "text",
        text: JSON.stringify(saved),
      });
      expect(await fixture.harness.snapshot(CodemodeStoreDoc, root, context)).toEqual({
        values: { counter: 64, old: saved },
      });
      expect(await fixture.harness.snapshotAsOf(CodemodeStoreDoc, root, marker, context)).toEqual({
        values: { counter: 0, old: saved },
      });
      const fork = await fixture.root.fork(marker, { ownership: { kind: "ownerless" } }, context);
      await fork.configure({ model: { provider: "faux", modelId: "faux-1" } }, context);
      expect(
        (await fixture.run('text(load("counter")); store("counter",1);', fork)).output,
      ).toContainEqual({ type: "text", text: "0" });
      expect(
        (await fixture.harness.snapshot(CodemodeStoreDoc, root, context))?.values.counter,
      ).toBe(64);
    } finally {
      await fixture.close();
      await authority.close();
    }
  });

  it("does not persist failed script writes", async () => {
    const fixture = await openCodemodeHarness(new CallableCatalog([]));
    try {
      await fixture.run('store("key","original");');
      expect((await fixture.run('store("key","bad"); throw new Error("script");')).isError).toBe(
        true,
      );
      expect(output(await fixture.run('text(load("key"));'))).toContain("original");
    } finally {
      await fixture.close();
    }
  });

  it("merges only changed keys from concurrent successful scripts", async () => {
    const entered = latch(),
      release = latch();
    const fast = 'await tools.wait_slow({}); store("fast",2);';
    const catalog = new CallableCatalog([
      defineTool({
        name: "hold",
        description: "hold",
        parameters: Type.Object({}),
        execute: async () => {
          entered.resolve();
          await release.promise;
          return { output: [] };
        },
      }),
      defineTool({
        name: "wait_slow",
        description: "wait",
        parameters: Type.Object({}),
        execute: async () => {
          await entered.promise;
          return { output: [] };
        },
      }),
    ]);
    const fixture = await openCodemodeHarness(catalog, {
      onResult: (source) => {
        if (source === fast) release.resolve();
      },
    });
    try {
      const results = await fixture.runMany(['await tools.hold({}); store("slow",1);', fast]);
      expect(results.every((result) => result.isError === false)).toBe(true);
      expect((await fixture.run('text([load("fast"),load("slow")]);')).output).toContainEqual({
        type: "text",
        text: "[2,1]",
      });
    } finally {
      release.resolve();
      await fixture.close();
    }
  });

  it("keeps per-invocation resource snapshots across concurrent success and failures", async () => {
    const lines: string[] = [];
    const task = new (class extends NoSimulationTask {
      override log(...parts: readonly unknown[]) {
        lines.push(parts.join(" "));
      }
    })("codemode", false);
    let arrivals = 0;
    const arrived = latch(),
      release = latch();
    const catalog = new CallableCatalog([
      defineTool({
        name: "hold",
        description: "hold",
        parameters: Type.Object({}),
        execute: async () => {
          if (++arrivals === 2) arrived.resolve();
          await release.promise;
          return { output: [] };
        },
      }),
    ]);
    const first = await openCodemodeHarness(catalog, { orb: { id: "orb-1", task } });
    const second = await openCodemodeHarness(catalog, { orb: { id: "orb-1", task } });
    const baseline = codeModeMemory.active;
    try {
      const holding = first.run(
        "const b=new Uint8Array(32*1024*1024).fill(1); await tools.hold({});",
      );
      const exhausting = second.run(
        "await tools.hold({}); const a=[]; for (;;) a.push(new Uint8Array(16*1024*1024).fill(1));",
      );
      await arrived.promise;
      expect(codeModeMemory.active).toBe(baseline + 2);
      release.resolve();
      const [held, exhausted] = await Promise.all([holding, exhausting]);
      expect(codeModeMemory.active).toBe(baseline);
      expect(held.isError).toBe(false);
      expect((held.details as { memory: { peakBytes: number } }).memory.peakBytes).toBeGreaterThan(
        32 * 1024 * 1024,
      );
      expect(exhausted.isError).toBe(true);
      expect(
        (exhausted.details as { memory: { peakBytes: number } }).memory.peakBytes,
      ).toBeGreaterThan(200 * 1024 * 1024);
      const flooded = await first.run('const s="x".repeat(600*1024); text(s); text(s);');
      expect(flooded.isError).toBe(true);
      expect(codeModeMemory.active).toBe(baseline);
      expect(lines.filter((line) => line.includes("codemode.resource_failed"))).toEqual([
        expect.stringContaining("kind=out_of_memory"),
        expect.stringContaining("kind=output_limit"),
      ]);
    } finally {
      release.resolve();
      await first.close();
      await second.close();
    }
  });
});

it("reports only bounded schema-owned missing names and respects catalog visibility", () => {
  const fields = [
    "context",
    'quote"\nfield',
    "x".repeat(65),
    ...Array.from({ length: 20 }, (_, i) => `field${i}`),
  ];
  const catalog = new CallableCatalog([
    defineTool({
      name: "required",
      description: "fixture",
      parameters: Type.Object(Object.fromEntries(fields.map((field) => [field, Type.String()]))),
      execute: async () => ({ output: [] }),
    }),
  ]);
  const message = catalog.invalidArgumentsMessage("required", {
    context: "secret-value",
    extra: "secret-value",
  });
  expect(message).not.toContain("secret-value");
  expect(message).not.toContain('"context"');
  expect(message).toContain(JSON.stringify('quote"\nfield'));
  expect(message).not.toContain("x".repeat(65));
  expect(message).not.toContain('"field15"');
  expect(message.length).toBeLessThan(1100);
  const generic = "Invalid arguments for required";
  for (const args of [
    null,
    [],
    "secret-value",
    Object.fromEntries(fields.map((field) => [field, 42])),
  ])
    expect(catalog.invalidArgumentsMessage("required", args)).toBe(generic);
  expect(catalog.without(["required"]).invalidArgumentsMessage("required", {})).toBe(generic);
  expect(
    catalog.invalidArgumentsMessage("required", Object.create({ context: "inherited" })),
  ).toContain('"context"');
});

it("sanitizes native invalid_arguments diagnostics without exposing their message or argument values", async () => {
  const fixture = await openCodemodeHarness(
    new CallableCatalog([
      defineTool({
        name: "reject",
        description: "fixture",
        parameters: Type.Object({ value: Type.String() }),
        execute: async (_args, api) => {
          api.diagnostic({
            severity: "error",
            code: "invalid_arguments",
            message: "secret-thirdparty-message",
          });
          return { isError: true, output: [] };
        },
      }),
    ]),
  );
  try {
    const result = await fixture.run(
      'try {await tools.reject({value:"secret-argument"});} catch(e) {text(e.message);}',
    );
    expect(result.output).toContainEqual({
      type: "text",
      text: "Invalid arguments for reject\nreject failed",
    });
    expect(output(result)).not.toContain("secret-");
  } finally {
    await fixture.close();
  }
});

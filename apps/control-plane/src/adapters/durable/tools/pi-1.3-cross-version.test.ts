import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineTool,
  type EntryId,
  Harness,
  MemoryStorage,
  type StorageWrite,
  type TaskId,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import {
  CODEMODE_MODULE_VERSION,
  CodemodeJournalDoc,
  CodemodeRunDoc,
  CodemodeStoreDoc,
} from "@earendil-works/pi-durable/codemode";
import { errAsync, okAsync } from "neverthrow";
import { assert, describe, expect, it, vi } from "vitest";
import { CallableCatalog } from "./catalog.ts";
import { PiCodemodeSandbox } from "./codemode-sandbox.ts";
import { createDurableTools } from "./index.ts";
import { openCodemodeHarness } from "./testkit/codemode.ts";

const context = BACKGROUND_CONTEXT;
const directory = new URL("./fixtures/pi-1.3-compat/", import.meta.url);
const now = 1_800_000_000_000;
function read<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, directory), "utf8"));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function restore(commits: StorageWrite[][]) {
  const storage = new MemoryStorage();
  for (const writes of commits) await storage.commit(writes, context);
  return storage;
}

describe("qualified Pi 1.3 native state on the current Pi", () => {
  it("seals the synthetic old fixture source, packages, generator, and crash cuts", () => {
    const provenance = read<{
      sourceCommit: string;
      packages: Record<string, string>;
      generatorSha256: string;
      fixtures: Record<string, string>;
      patches: { file: string; sha256: string }[];
      installed: { file: string; sha256: string }[];
    }>("provenance.json");
    expect(provenance.sourceCommit).toBe("3ce807c7d27cec1661a758df084e35266c5b3cd1");
    expect(Object.values(provenance.packages)).toEqual(["1.3.0", "1.3.0", "1.3.0", "1.3.0"]);
    const hash = (file: string) =>
      createHash("sha256")
        .update(readFileSync(new URL(file, directory)))
        .digest("hex");
    expect(hash("generate.ts")).toBe(provenance.generatorSha256);
    for (const [file, digest] of Object.entries(provenance.fixtures))
      expect(hash(file)).toBe(digest);
    expect(provenance.patches).toHaveLength(4);
    expect(provenance.installed).toHaveLength(18);
    expect(CODEMODE_MODULE_VERSION).toBe(2);
    expect(
      [CodemodeRunDoc, CodemodeJournalDoc, CodemodeStoreDoc].map((doc) => doc.definition.version),
    ).toEqual([1, 1, 1]);
  });

  it("reuses the old decided script result without a VM or completed callback rerun", async () => {
    const old = read<{ root: number; result: ToolExecutionResult; commits: StorageWrite[][] }>(
      "completed.json",
    );
    let effects = 0;
    const result = deferred<ToolExecutionResult>();
    const starts = vi.spyOn(PiCodemodeSandbox.prototype, "start");
    const fixture = await openCodemodeHarness(
      new CallableCatalog([
        defineTool({
          name: "record_once",
          description: "record_once",
          parameters: Type.Object({}),
          replay: "safe",
          execute: async () => {
            effects++;
            return { output: [] };
          },
        }),
      ]),
      { storage: await restore(old.commits), onResult: (_source, value) => result.resolve(value) },
    );
    try {
      fixture.harness.resume();
      expect(await result.promise).toEqual(old.result);
      await fixture.root.waitForIdle(context);
      expect(effects).toBe(0);
      expect(starts).not.toHaveBeenCalled();
      expect(
        (await fixture.harness.snapshot(CodemodeStoreDoc, fixture.root.id, context))?.values
          .completed,
      ).toBe(true);
    } finally {
      await fixture.close();
      starts.mockRestore();
    }
  });

  it("retains old store values, success-only writes and history through the 64-delta base", async () => {
    const old = read<{
      root: number;
      storeId: number;
      markers: Record<string, EntryId>;
      deltaCount: number;
      commits: StorageWrite[][];
    }>("store.json");
    expect(old.deltaCount).toBe(63);
    const storage = await restore(old.commits);
    const writes: StorageWrite[] = [];
    const commit = storage.commit.bind(storage);
    storage.commit = async (batch, ctx) => {
      const seq = await commit(batch, ctx);
      writes.push(...structuredClone(batch));
      return seq;
    };
    const fixture = await openCodemodeHarness(new CallableCatalog([]), { storage });
    try {
      expect(fixture.root.id).toBe(old.root);
      const snapshot = () => fixture.harness.snapshot(CodemodeStoreDoc, fixture.root.id, context);
      const historical = (entry: EntryId) =>
        fixture.harness.snapshotAsOf(CodemodeStoreDoc, fixture.root.id, entry, context);
      expect(await snapshot()).toEqual({
        values: { counter: 63, old: { version: "1.3.0", nested: [1, true, null] } },
      });
      expect((await historical(old.markers["32"]!))?.values.counter).toBe(32);
      expect((await fixture.run('text(load("old")); store("counter",64);')).isError).toBe(false);
      expect((await snapshot())?.values.counter).toBe(64);
      expect((await fixture.run('store("counter",65);')).isError).toBe(false);
      expect((await snapshot())?.values.counter).toBe(65);
      expect(
        writes
          .filter((write) => write.type === "document.change" && write.id === old.storeId)
          .map((write) => write.type === "document.change" && write.content.kind),
      ).toEqual(["delta", "base"]);
      expect(
        (await fixture.run('store("counter",-2); throw new Error("synthetic failure");')).isError,
      ).toBe(true);
      expect((await snapshot())?.values.counter).toBe(65);
      expect((await historical(old.markers["63"]!))?.values.counter).toBe(63);
      const fork = await fixture.root.fork(
        old.markers["32"]!,
        { ownership: { kind: "ownerless" } },
        context,
      );
      expect(
        (await fixture.harness.snapshot(CodemodeStoreDoc, fork.id, context))?.values.counter,
      ).toBe(32);
      expect(
        (await fixture.run('text(load("counter")); store("counter",33);', fork)).output,
      ).toContainEqual({ type: "text", text: "32" });
      expect((await snapshot())?.values.counter).toBe(65);
      await fixture.root.submit(
        { type: "write", entry: { kind: "fixture.context-head", head: old.markers["32"]! } },
        context,
      );
      expect((await snapshot())?.values.counter).toBe(65);
      expect((await historical(old.markers["32"]!))?.values.counter).toBe(32);
      expect((await fixture.run('text(load("counter"));')).output).toContainEqual({
        type: "text",
        text: "65",
      });
    } finally {
      await fixture.close();
    }
  });

  for (const alteration of [
    "none",
    "authorization",
    "unsafe",
    "version",
    "fingerprint",
    "deadline",
    "divergence",
  ] as const) {
    it(`recovers old admitted callbacks without new unsafe effects: ${alteration}`, async () => {
      const old = read<{
        root: number;
        outer: TaskId;
        commits: StorageWrite[][];
        children: {
          id: TaskId;
          input: { kind: string; parent: TaskId; key: string; call: { name: string } };
          state: { status: string; checkpoint: { phase: string; replay: string } };
        }[];
        events: { event: string; name: string; taskId?: TaskId }[];
      }>(alteration === "unsafe" ? "interrupted-unsafe.json" : "interrupted-safe.json");
      const recorded = old.children.find((child) => child.input.call.name === "record_once")!;
      const pending = old.children.find((child) => child.input.call.name === "hold_restart")!;
      expect(recorded.state.status).toBe("terminal");
      expect(
        old.events.filter((event) => event.event === "prepare").map((event) => event.name),
      ).toEqual(["record_once", "hold_restart"]);
      expect([recorded.input.key, pending.input.key]).toEqual(["c1", "c2"]);
      expect(pending.state).toMatchObject({
        status: "running",
        checkpoint: { phase: "execute", replay: alteration === "unsafe" ? "unsafe" : "safe" },
      });
      expect(
        old.events.filter((event) => event.event === "execute").map((event) => event.name),
      ).toEqual(["record_once", "hold_restart"]);
      const storage = await restore(old.commits);
      const effects: { name: string; taskId: TaskId }[] = [];
      const admissions: string[] = [];
      const authorizations: { name: string; taskId: TaskId }[] = [];
      const callbacks: { name: string; key: string | undefined }[] = [];
      const ready = deferred<void>();
      const complete = deferred<ToolExecutionResult>();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const bundle = createDurableTools({
        authorize: (name, _args, api) => {
          authorizations.push({ name, taskId: api.taskId });
          if (name === "hold_restart" && alteration === "authorization") {
            ready.resolve();
            return errAsync({ code: "forbidden", message: "Current authorization denied" });
          }
          return okAsync(undefined);
        },
        additionalTools: ["record_once", "hold_restart", "post_hold"].map((name) =>
          defineTool({
            name,
            description: name,
            parameters: Type.Object({}),
            replay: name === "hold_restart" && alteration === "unsafe" ? "unsafe" : "safe",
            prepareArguments: (args) => {
              assert(args !== null && typeof args === "object" && !Array.isArray(args));
              admissions.push(name);
              return args;
            },
            execute: async (_args, api) => {
              effects.push({ name, taskId: api.taskId });
              if (name === "hold_restart") ready.resolve();
              return { output: [{ type: "text", text: name + ":result" }] };
            },
          }),
        ),
      });
      const native = bundle.extension.tools!.find((tool) => tool.name === "codemode")!;
      const extension = {
        ...bundle.extension,
        tools: bundle.extension.tools!.map((tool) =>
          tool !== native
            ? tool
            : defineTool({
                ...native,
                execute: async (args, api, ctx) => {
                  // Existing safe children resume independently, even when the parent refuses replay.
                  if (alteration !== "unsafe") await ready.promise;
                  const result = await native.execute(
                    args,
                    {
                      ...api,
                      executeTool: (name, value, callContext, options) => {
                        callbacks.push({ name, key: options?.key });
                        return api.executeTool(name, value, callContext, options);
                      },
                    },
                    ctx,
                  );
                  complete.resolve(result);
                  return result;
                },
              }),
        ),
      };
      const registry = createRegistry();
      registry.install(extension);
      const faux = fauxProvider();
      faux.setResponses([fauxAssistantMessage("done")]);
      const models = createModels();
      models.setProvider(faux.provider);
      const harness = await Harness.open(storage, { models, registry, now: () => now }, context);
      try {
        const root = await harness.root(context);
        await root.commit(async (tx) => {
          const run = await tx.doc(CodemodeRunDoc, old.outer);
          assert(run.start);
          expect(run.start).toMatchObject({ version: 2, startedAt: now, seed: 12345 });
          expect(run.result).toBeUndefined();
          const journal = await tx.doc(CodemodeJournalDoc, old.outer);
          expect(journal.entries).toHaveLength(1);
          if (alteration === "version") run.start.version++;
          if (alteration === "fingerprint") run.start.fingerprint = "changed-engine";
          if (alteration === "deadline") run.start.deadline = now - 1;
          if (alteration === "divergence") journal.firstIssued = (journal.firstIssued ?? 0) + 1;
        }, context);
        harness.resume();
        const result = await complete.promise;
        await root.waitForIdle(context);
        expect(result.isError).toBe(alteration !== "none");
        expect(effects.filter(({ name }) => name === "record_once")).toEqual([]);
        expect(effects.filter(({ name }) => name === "hold_restart")).toEqual(
          alteration === "unsafe" || alteration === "authorization"
            ? []
            : [{ name: "hold_restart", taskId: pending.id }],
        );
        expect(authorizations.filter(({ name }) => name === "record_once")).toEqual([]);
        expect(authorizations.filter(({ name }) => name === "hold_restart")).toEqual(
          alteration === "unsafe" ? [] : [{ name: "hold_restart", taskId: pending.id }],
        );
        expect(admissions).toEqual(alteration === "none" ? ["post_hold"] : []);
        expect(effects.filter(({ name }) => name === "post_hold")).toHaveLength(
          alteration === "none" ? 1 : 0,
        );
        const tasks = (
          await storage.scanTasks({ conversationId: root.id }, 1000, undefined, context)
        ).items;
        const children = tasks.filter((task) => task.owner === old.outer);
        expect(children.map((task) => task.id).sort((a, b) => a - b)).toEqual(
          alteration === "none"
            ? [
                recorded.id,
                pending.id,
                effects.find(({ name }) => name === "post_hold")!.taskId,
              ].sort((a, b) => a - b)
            : [recorded.id, pending.id].sort((a, b) => a - b),
        );
        for (const child of old.children) {
          expect(await storage.task(child.id, context)).toMatchObject({
            id: child.id,
            owner: old.outer,
            input: child.input,
          });
        }
        expect((await harness.snapshot(CodemodeStoreDoc, root.id, context))?.values.resumed).toBe(
          alteration === "none" ? true : undefined,
        );
        if (alteration !== "none") {
          for (const callback of callbacks)
            expect(
              old.children.some(
                (child) =>
                  child.input.call.name === callback.name && child.input.key === callback.key,
              ),
            ).toBe(true);
          expect(JSON.stringify(result.output)).toMatch(
            {
              authorization: /Current authorization denied/,
              unsafe: /interrupted.*may have partially run/,
              version: /code mode version 3, this is 2/,
              fingerprint: /sandbox changed/,
              deadline: /deadline passed/,
              divergence: /call history changed/,
            }[alteration],
          );
        }
      } finally {
        await harness.close(context);
        await bundle.close();
        clock.mockRestore();
      }
    });
  }
});

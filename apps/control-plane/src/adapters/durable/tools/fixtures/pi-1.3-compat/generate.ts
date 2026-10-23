// Run a temporary copy with the qualified 1.3 installation; see provenance.json.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type EntryId,
  MemoryStorage,
  type StorageWrite,
} from "@earendil-works/pi-durable";
import { CodemodeStoreDoc } from "@earendil-works/pi-durable/codemode";
import { okAsync } from "neverthrow";
import { assert, expect, it, vi } from "vitest";

const context = BACKGROUND_CONTEXT;
const now = 1_800_000_000_000;
const baseline = process.env.PI13_BASELINE!;
const output = process.env.PI13_OUTPUT!;
const source = join(baseline, "apps/control-plane/src/adapters/durable/tools");
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function recording() {
  const storage = new MemoryStorage();
  const commits: StorageWrite[][] = [];
  const commit = storage.commit.bind(storage);
  storage.commit = async (writes, ctx) => {
    const seq = await commit(writes, ctx);
    commits.push(structuredClone([...writes]));
    return seq;
  };
  return { storage, commits };
}
// Fold mutable rows and superseded current-only revisions; preserve commit positions.
async function compact(recorded: ReturnType<typeof recording>) {
  const rows = recorded.commits.flat();
  const currentOnly = new Set(
    rows.flatMap((write) =>
      write.type === "document.create" &&
      (write.record.scope.kind !== "conversation" || write.record.history === "latest")
        ? [write.record.id]
        : [],
    ),
  );
  const bases = new Map<number, number>();
  const last = new Map<string, StorageWrite>();
  for (const [index, write] of rows.entries()) {
    if (
      write.type === "document.change" &&
      currentOnly.has(write.id) &&
      write.content.kind === "base"
    )
      bases.set(write.id, index);
    if (write.type === "task" || write.type === "submission")
      last.set(`${write.type}:${write.value.id}`, write);
  }
  const commits = recorded.commits.map((batch) =>
    batch.filter((write) => {
      if (write.type === "document.change")
        return rows.indexOf(write) >= (bases.get(write.id) ?? 0);
      return write.type !== "task" && write.type !== "submission"
        ? true
        : last.get(`${write.type}:${write.value.id}`) === write;
    }),
  );
  const restored = new MemoryStorage();
  for (const batch of commits) await restored.commit(batch, context);
  for (const write of rows) {
    if (write.type === "task")
      expect(await restored.task(write.value.id, context)).toEqual(
        await recorded.storage.task(write.value.id, context),
      );
    if (write.type === "submission")
      expect(await restored.submission(write.value.id, context)).toEqual(
        await recorded.storage.submission(write.value.id, context),
      );
    if (write.type === "document.create")
      expect(await restored.document(write.record.id, "current", context)).toEqual(
        await recorded.storage.document(write.record.id, "current", context),
      );
  }
  await restored.close(context);
  return commits;
}
function save(name: string, value: object) {
  const formatted = execFileSync(
    process.execPath,
    [
      join(baseline, "node_modules/@biomejs/biome/bin/biome"),
      "format",
      "--config-path",
      join(baseline, "biome.json"),
      "--stdin-file-path",
      join(baseline, name),
    ],
    { cwd: baseline, input: JSON.stringify(value), encoding: "utf8" },
  );
  writeFileSync(join(output, name), formatted);
}

it("captures synthetic old native store and interrupted callbacks", async () => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
    assert(array !== null);
    if (array instanceof Uint32Array) array.fill(12345);
    else new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(7);
    return array;
  });
  const { openCodemodeHarness } = (await import(
    join(source, "testkit/codemode.ts")
  )) as typeof import("../../testkit/codemode.ts");
  const { CallableCatalog } = (await import(
    join(source, "catalog.ts")
  )) as typeof import("../../catalog.ts");
  const installer = readFileSync(join(baseline, "scripts/apply-dependency-patches.mjs"), "utf8");
  const installed = [
    ...installer.matchAll(/"(node_modules[^"]+)": \[\s*"[a-f\d]{64}",\s*"([a-f\d]{64})"/g),
  ].map((match) => {
    const file = match[1]!;
    const sha256 = hash(readFileSync(join(baseline, file)));
    assert(sha256 === match[2], file);
    return { file, sha256 };
  });
  assert(installed.length === 18);
  assert(
    execFileSync("git", ["status", "--porcelain"], { cwd: baseline, encoding: "utf8" }).trim() ===
      "",
  );
  try {
    const recorded = recording();
    const fixture = await openCodemodeHarness(new CallableCatalog([]), {
      storage: recorded.storage,
    });
    await fixture.run('store("counter",0); store("old",{version:"1.3.0",nested:[1,true,null]});');
    const markers: Record<string, EntryId> = {};
    const mark = async (counter: number) => {
      const entry = await fixture.root.commit(
        (tx) => tx.appendEntry(fixture.root.id, { kind: "fixture.marker", data: { counter } }),
        context,
      );
      markers[String(counter)] = entry.id;
    };
    await mark(0);
    const successful = await fixture.harness.snapshot(CodemodeStoreDoc, fixture.root.id, context);
    assert(successful?.values.counter === 0);
    const failed = await fixture.run(
      'store("counter",-1); throw new Error("synthetic fixture failure");',
    );
    assert(failed.isError);
    assert(
      (await fixture.harness.snapshot(CodemodeStoreDoc, fixture.root.id, context))?.values
        .counter === 0,
    );
    const storeId = (await recorded.storage.findDocument(
      {
        kind: "pi.codemode.store",
        scope: { kind: "conversation", conversationId: fixture.root.id },
      },
      "current",
      context,
    ))!.id;
    await fixture.root.commit(async (tx) => {
      (await tx.doc(CodemodeStoreDoc, fixture.root.id)).values.counter = 2;
    }, context);
    await mark(2);
    await fixture.settle();
    // This fixture needs only the old agent/store and their history, not finished VM tasks.
    const commits = recorded.commits.map((batch) =>
      batch.filter(
        (write) =>
          write.type === "conversation" ||
          (write.type === "entry" && write.value.kind === "fixture.marker") ||
          (write.type === "document.create" &&
            (write.record.kind === "pi.agent" || write.record.id === storeId)) ||
          (write.type === "document.change" && write.id === storeId),
      ),
    );
    const restored = new MemoryStorage();
    for (const batch of commits) await restored.commit(batch, context);
    expect(await restored.document(storeId, "current", context)).toEqual(
      await recorded.storage.document(storeId, "current", context),
    );
    for (const entry of Object.values(markers)) {
      const marker = await recorded.storage.entry(entry, context);
      assert(marker);
      expect(await restored.entry(entry, context)).toEqual(marker);
      expect(await restored.document(storeId, marker.commitSeq, context)).toEqual(
        await recorded.storage.document(storeId, marker.commitSeq, context),
      );
    }
    const stored = await restored.document(storeId, "current", context);
    assert(stored?.deltasSinceBase === 2);
    save("store.json", { root: fixture.root.id, storeId, markers, deltaCount: 2, commits });
    await restored.close(context);
    await fixture.close();

    const completedStorage = recording();
    const completed = await openCodemodeHarness(
      new CallableCatalog([
        defineTool({
          name: "record_once",
          description: "record_once",
          parameters: Type.Object({}),
          replay: "safe",
          execute: async () => ({ output: [{ type: "text", text: "recorded" }] }),
        }),
      ]),
      { storage: completedStorage.storage, holdForReplay: true },
    );
    const result = await completed.run(
      'text(await tools.record_once({})); store("completed",true);',
    );
    save("completed.json", {
      root: completed.root.id,
      result,
      commits: await compact(completedStorage),
    });
    await completed.close();

    for (const replay of ["safe", "unsafe"] as const) {
      const recorded = recording();
      const held = deferred<number>();
      const events: { event: string; name: string; taskId?: number }[] = [];
      const authorize: import("../../catalog.ts").AuthorizeTool = (name, _args, api) => {
        events.push({ event: "authorize", name, taskId: api.taskId });
        return okAsync(undefined);
      };
      const tools = ["record_once", "hold_restart", "post_hold"].map((name) =>
        defineTool({
          name,
          description: name,
          parameters: Type.Object({}),
          replay: name === "hold_restart" ? replay : "safe",
          prepareArguments: (args) => {
            assert(args !== null && typeof args === "object" && !Array.isArray(args));
            events.push({ event: "prepare", name });
            return args;
          },
          execute: async (_args, api, ctx) => {
            events.push({ event: "execute", name, taskId: api.taskId });
            if (name === "hold_restart") {
              const task = await api.getTask(api.taskId, ctx);
              assert(task?.owner !== undefined);
              held.resolve(task.owner);
              await new Promise<void>((resolve) =>
                ctx.abortSignal!.addEventListener("abort", () => resolve(), { once: true }),
              );
            }
            return { output: [{ type: "text", text: name + ":result" }] };
          },
        }),
      );
      const fixture = await openCodemodeHarness(new CallableCatalog(tools, authorize), {
        storage: recorded.storage,
      });
      const running = fixture.run(
        'text(await tools.record_once({})); await tools.hold_restart({}); await tools.post_hold({}); store("resumed",true);',
      );
      const root = fixture.root;
      const outer = await held.promise;
      // Snapshot a crash cut while the callback is running, before graceful shutdown.
      save("interrupted-" + replay + ".json", {
        root: root.id,
        outer,
        events,
        commits: await compact(recorded),
      });
      await fixture.close();
      await running;
    }
    const patches = ["pi-ai", "pi-coding-agent", "pi-codemode", "pi-durable"].map((name) => {
      const file = "@earendil-works+" + name + "+1.3.0.patch";
      return { file, sha256: hash(readFileSync(join(baseline, "patches", file))) };
    });
    const files = [
      "store.json",
      "completed.json",
      "interrupted-safe.json",
      "interrupted-unsafe.json",
    ];
    save("provenance.json", {
      sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: baseline,
        encoding: "utf8",
      }).trim(),
      node: process.version,
      packages: Object.fromEntries(
        ["pi-ai", "pi-codemode", "pi-durable", "pi-coding-agent"].map((name) => [
          name,
          JSON.parse(
            readFileSync(
              join(baseline, "node_modules/@earendil-works", name, "package.json"),
              "utf8",
            ),
          ).version,
        ]),
      ),
      now,
      seed: 12345,
      patches,
      installed,
      generatorSha256: hash(readFileSync(import.meta.filename)),
      fixtures: Object.fromEntries(
        files.map((file) => [file, hash(readFileSync(join(output, file)))]),
      ),
    });
  } finally {
    vi.restoreAllMocks();
  }
});

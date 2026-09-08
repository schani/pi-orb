import { mkdtempSync, rmSync } from "node:fs";
import { type FileHandle, open, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoSimulationTask } from "determined";
import { okAsync, ResultAsync } from "neverthrow";
import { afterEach, describe, expect, it } from "vitest";
import {
  generatedDigest,
  generatedSource,
  hostedByteStoreContract,
} from "./byte-store.contract.ts";
import { createFilesystemHostedByteStore } from "./filesystem.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("FilesystemHostedByteStore", () => {
  hostedByteStoreContract(async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-orb-hosting-files-"));
    roots.push(root);
    return {
      store: createFilesystemHostedByteStore({ root }),
      restart: () => createFilesystemHostedByteStore({ root }),
    };
  });

  it("lets cancellation win while a writer is paused before finalization", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-orb-hosting-files-race-"));
    roots.push(root);
    const store = createFilesystemHostedByteStore({ root });
    const task = new NoSimulationTask("filesystem cancellation race", false);
    const context = { signal: new AbortController().signal };
    let release: (() => void) | undefined;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached: (() => void) | undefined;
    const firstPull = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let pull = 0;
    let closes = 0;
    const source = {
      next: () => {
        if (pull++ === 0) {
          reached?.();
          return okAsync(new Uint8Array([0]));
        }
        return ResultAsync.fromSafePromise(paused).map(() => null);
      },
      close: () => {
        closes++;
        return okAsync(undefined);
      },
    };
    const expected = { size: 1, sha256: generatedDigest(1) };
    const begun = await store.begin(task, "race", expected, context);
    expect(begun.isOk()).toBe(true);
    if (begun.isErr()) return;
    const writing = store.write(task, begun.value.sessionId, source, expected, context);
    await firstPull;
    const cancelled = await store.cancel(task, begun.value.sessionId, context);
    expect(cancelled.isOk() && cancelled.value.type === "cancelled").toBe(true);
    release?.();
    expect((await writing).isErr()).toBe(true);
    expect(closes).toBe(1);
    const queried = await store.query(task, begun.value.sessionId, context);
    expect(queried.isOk() && queried.value.type === "cancelled").toBe(true);
  });

  it("retries short filesystem writes before publishing", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-orb-hosting-short-write-"));
    roots.push(root);
    const openFile = async (path: string, flags: string, mode?: number): Promise<FileHandle> => {
      const handle = await open(path, flags, mode);
      if (flags !== "r+") return handle;
      const original = handle.write.bind(handle);
      handle.write = ((
        buffer: Uint8Array,
        offset: number,
        length: number,
        position: number | null,
      ) =>
        original(
          buffer,
          offset,
          Math.max(1, Math.floor(length / 2)),
          position,
        )) as FileHandle["write"];
      return handle;
    };
    const store = createFilesystemHostedByteStore({ openFile, root });
    const task = new NoSimulationTask("filesystem short write", false);
    const context = { signal: new AbortController().signal };
    const expected = { size: 70_000, sha256: generatedDigest(70_000) };
    const begun = await store.begin(task, "short", expected, context);
    expect(begun.isOk()).toBe(true);
    if (begun.isErr()) return;
    const written = await store.write(
      task,
      begun.value.sessionId,
      generatedSource(expected.size),
      expected,
      context,
    );
    expect(written.isOk()).toBe(true);
    if (written.isErr()) return;
    const stat = await store.statExact(task, written.value.ref, context);
    expect(stat.isOk() && stat.value?.size === expected.size).toBe(true);
  });

  it("recovers after publication crashes before terminal-session persistence", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-orb-hosting-commit-crash-"));
    roots.push(root);
    let failTerminalRename = true;
    const crashing = createFilesystemHostedByteStore({
      root,
      renameFile: async (oldPath, newPath) => {
        if (failTerminalRename && oldPath.includes(".committed.json.")) {
          failTerminalRename = false;
          const failure = new Error("simulated crash") as NodeJS.ErrnoException;
          failure.code = "EIO";
          return Promise.reject(failure);
        }
        await rename(oldPath, newPath);
      },
    });
    const task = new NoSimulationTask("filesystem commit crash", false);
    const context = { signal: new AbortController().signal };
    const expected = { size: 1, sha256: generatedDigest(1) };
    const begun = await crashing.begin(task, "crash", expected, context);
    expect(begun.isOk()).toBe(true);
    if (begun.isErr()) return;
    expect(
      (
        await crashing.write(task, begun.value.sessionId, generatedSource(1), expected, context)
      ).isErr(),
    ).toBe(true);

    const restarted = createFilesystemHostedByteStore({ root });
    const recovered = await restarted.query(task, begun.value.sessionId, context);
    expect(recovered.isOk() && recovered.value.type === "committed").toBe(true);
    if (recovered.isErr() || recovered.value.type !== "committed") return;
    expect((await restarted.deleteExact(task, recovered.value.object.ref, context)).isOk()).toBe(
      true,
    );
    const terminal = await restarted.cancel(task, begun.value.sessionId, context);
    expect(terminal.isOk() && terminal.value.type === "committed").toBe(true);
  });
});

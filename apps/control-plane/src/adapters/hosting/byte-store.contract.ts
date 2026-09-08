import { createHash, randomUUID } from "node:crypto";
import { NoSimulationTask } from "determined";
import { errAsync, okAsync } from "neverthrow";
import { expect, it } from "vitest";
import type { HostedByteSource, HostedByteStore } from "../../domain/hosting-ports.ts";

const task = new NoSimulationTask("hosting byte adapter contract", false);
const context = (): { signal: AbortSignal } => ({ signal: new AbortController().signal });
export const generatedDigest = (size: number): string => {
  const hash = createHash("sha256");
  for (let offset = 0; offset < size; offset += 8191) {
    const length = Math.min(8191, size - offset);
    const chunk = new Uint8Array(length);
    for (let index = 0; index < length; index++) chunk[index] = (offset + index) % 251;
    hash.update(chunk);
  }
  return hash.digest("hex");
};

export function generatedSource(
  size: number,
  failAt?: number,
): HostedByteSource & {
  closed: () => number;
  largestPull: () => number;
} {
  let offset = 0;
  let closes = 0;
  let largest = 0;
  return {
    closed: () => closes,
    largestPull: () => largest,
    next: () => {
      if (failAt !== undefined && offset >= failAt) {
        return errAsync({ type: "hosting_retryable", message: "generated source failed" });
      }
      if (offset === size) return okAsync(null);
      const length = Math.min(8191, size - offset);
      const chunk = new Uint8Array(length);
      for (let index = 0; index < length; index++) chunk[index] = (offset + index) % 251;
      offset += length;
      largest = Math.max(largest, length);
      return okAsync(chunk);
    },
    close: () => {
      closes++;
      return okAsync(undefined);
    },
  };
}

async function readAll(source: HostedByteSource): Promise<{ hash: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for (;;) {
    const next = await source.next(task, context());
    expect(next.isOk()).toBe(true);
    if (next.isErr()) return { hash: "", size: -1 };
    if (next.value === null) break;
    size += next.value.byteLength;
    hash.update(next.value);
  }
  const closed = await source.close(task);
  expect(closed.isOk()).toBe(true);
  return { hash: hash.digest("hex"), size };
}

export function hostedByteStoreContract(
  create: () => Promise<{ store: HostedByteStore; restart: () => HostedByteStore }>,
  keyPrefix = "",
): void {
  it("streams, verifies integrity, survives restart, and deletes only the exact generation", async () => {
    const { store, restart } = await create();
    const size = 700_003;
    const expected = { size, sha256: generatedDigest(size) };
    const begun = await store.begin(task, `${keyPrefix}orb/object`, expected, context());
    expect(begun.isOk()).toBe(true);
    if (begun.isErr()) return;
    const source = generatedSource(size);
    const written = await store.write(task, begun.value.sessionId, source, expected, context());
    expect(written.isOk()).toBe(true);
    expect(source.closed()).toBe(1);
    expect(source.largestPull()).toBeLessThan(size);
    if (written.isErr()) return;

    const reopened = restart();
    const stat = await reopened.statExact(task, written.value.ref, context());
    expect(stat).toEqual({ value: written.value });
    const opened = await reopened.openExact(task, written.value.ref, context());
    expect(opened.isOk()).toBe(true);
    if (opened.isErr()) return;
    expect(await readAll(opened.value.source)).toEqual({ hash: expected.sha256, size });

    const wrong = { ...written.value.ref, generation: randomUUID() };
    expect((await reopened.deleteExact(task, wrong, context())).isOk()).toBe(true);
    expect((await reopened.statExact(task, written.value.ref, context())).isOk()).toBe(true);
    expect((await reopened.deleteExact(task, written.value.ref, context())).isOk()).toBe(true);
    expect((await reopened.deleteExact(task, written.value.ref, context())).isOk()).toBe(true);
    const absent = await reopened.statExact(task, written.value.ref, context());
    expect(absent.isOk() && absent.value === null).toBe(true);
    const terminal = await reopened.cancel(task, begun.value.sessionId, context());
    expect(terminal.isOk()).toBe(true);
  });

  it("closes a failed source and never exposes its partial object", async () => {
    const { store } = await create();
    const begun = await store.begin(
      task,
      `${keyPrefix}orb/failure`,
      { size: 100_000, sha256: generatedDigest(100_000) },
      context(),
    );
    expect(begun.isOk()).toBe(true);
    if (begun.isErr()) return;
    const source = generatedSource(100_000, 20_000);
    const result = await store.write(
      task,
      begun.value.sessionId,
      source,
      { size: 100_000, sha256: generatedDigest(100_000) },
      context(),
    );
    expect(result.isErr()).toBe(true);
    expect(source.closed()).toBe(1);
    const state = await store.query(task, begun.value.sessionId, context());
    expect(state.isOk() && state.value.type === "cancelled").toBe(true);
  });

  it("cancellation terminally fences a later write", async () => {
    const { store } = await create();
    const begun = await store.begin(
      task,
      `${keyPrefix}orb/cancelled`,
      { size: 1, sha256: generatedDigest(1) },
      context(),
    );
    expect(begun.isOk()).toBe(true);
    if (begun.isErr()) return;
    expect((await store.cancel(task, begun.value.sessionId, context()))._unsafeUnwrap()).toEqual({
      type: "cancelled",
    });
    const source = generatedSource(1);
    expect(
      (
        await store.write(
          task,
          begun.value.sessionId,
          source,
          { size: 1, sha256: generatedDigest(1) },
          context(),
        )
      ).isErr(),
    ).toBe(true);
    expect(source.closed()).toBe(1);
  });
}

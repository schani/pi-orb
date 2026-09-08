import { createHash, randomUUID } from "node:crypto";
import { NoSimulationTask } from "determined";
import { describe, expect, it } from "vitest";
import type { StoredHostedObject } from "../../domain/hosting-types.ts";
import { generatedDigest, generatedSource } from "./byte-store.contract.ts";
import { createGcsHostedByteStore, createGcsTokenProvider } from "./gcs.ts";

const bucket = process.env["PI_ORB_TEST_HOSTING_BUCKET"];
const task = new NoSimulationTask("live GCS hosting contract", false);
const context = () => ({ signal: new AbortController().signal });

describe.skipIf(bucket === undefined)("GcsHostedByteStore live contract", () => {
  const store = createGcsHostedByteStore({ auth: createGcsTokenProvider(), bucket: bucket ?? "" });

  for (const size of [0, 700_003]) {
    it(`streams and exactly deletes a ${size}-byte generated object`, async () => {
      const expected = { size, sha256: generatedDigest(size) };
      let sessionId: string | undefined;
      let object: StoredHostedObject | undefined;
      try {
        const begun = await store.begin(
          task,
          `contract-${randomUUID()}/object`,
          expected,
          context(),
        );
        expect(begun.isOk()).toBe(true);
        if (begun.isErr()) return;
        sessionId = begun.value.sessionId;
        const source = generatedSource(size);
        const written = await store.write(task, sessionId, source, expected, context());
        expect(written.isOk()).toBe(true);
        expect(source.largestPull()).toBeLessThanOrEqual(8191);
        if (written.isErr()) return;
        object = written.value;
        const adopted = await store.cancel(task, sessionId, context());
        expect(
          adopted.isOk() &&
            adopted.value.type === "committed" &&
            adopted.value.object.ref.generation === object.ref.generation,
        ).toBe(true);
        const opened = await store.openExact(task, object.ref, context());
        expect(opened.isOk()).toBe(true);
        if (opened.isErr()) return;
        const hash = createHash("sha256");
        let readSize = 0;
        for (;;) {
          const next = await opened.value.source.next(task, context());
          expect(next.isOk()).toBe(true);
          if (next.isErr() || next.value === null) break;
          readSize += next.value.byteLength;
          hash.update(next.value);
        }
        expect((await opened.value.source.close(task)).isOk()).toBe(true);
        expect({ sha256: hash.digest("hex"), size: readSize }).toEqual(expected);
        expect(
          (await store.deleteExact(task, { ...object.ref, generation: "1" }, context())).isOk(),
        ).toBe(true);
        expect((await store.statExact(task, object.ref, context())).isOk()).toBe(true);
        expect((await store.deleteExact(task, object.ref, context())).isOk()).toBe(true);
        expect((await store.deleteExact(task, object.ref, context())).isOk()).toBe(true);
        const terminal = await store.cancel(task, sessionId, context());
        expect(terminal.isOk()).toBe(true);
        object = undefined;
        sessionId = undefined;
      } finally {
        if (object !== undefined) await store.deleteExact(task, object.ref, context());
        if (sessionId !== undefined) {
          const terminal = await store.cancel(task, sessionId, context());
          if (terminal.isOk() && terminal.value.type === "committed")
            await store.deleteExact(task, terminal.value.object.ref, context());
        }
      }
    });
  }

  it("terminally cancels a session before a late writer can send bytes", async () => {
    const expected = { size: 1, sha256: generatedDigest(1) };
    const begun = await store.begin(
      task,
      `contract-${randomUUID()}/cancelled`,
      expected,
      context(),
    );
    expect(begun.isOk()).toBe(true);
    if (begun.isErr()) return;
    try {
      const terminal = await store.cancel(task, begun.value.sessionId, context());
      expect(terminal.isOk() && terminal.value.type === "cancelled").toBe(true);
      expect(
        (
          await store.write(task, begun.value.sessionId, generatedSource(1), expected, context())
        ).isErr(),
      ).toBe(true);
    } finally {
      await store.cancel(task, begun.value.sessionId, context());
    }
  });
});

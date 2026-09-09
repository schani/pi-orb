import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { UPLOAD_CHUNK_BYTES } from "@pi-orb/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { UploadFilesystem } from "./filesystem.ts";

const spec = { id: "a0000000-0000-4000-8000-000000000001", name: "binary.dat", size: 7 };
const dirs: string[] = [];
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "orb-upload-"));
  dirs.push(dir);
  return { dir, files: new UploadFilesystem(dir) };
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
describe("workspace upload filesystem", () => {
  it("streams binary chunks, survives lost acknowledgements and publishes exactly once", async () => {
    const { dir, files } = await setup();
    const bytes = Buffer.from([0, 255, 2, 3, 4, 0, 6]);
    expect(
      (
        await files.chunk(spec, 0, 3, Readable.from([bytes.subarray(0, 1), bytes.subarray(1, 3)]))
      ).isOk(),
    ).toBe(true);
    const restarted = new UploadFilesystem(dir);
    expect((await restarted.status(spec))._unsafeUnwrap().offset).toBe(3);
    expect((await restarted.chunk(spec, 0, 3, Readable.from([bytes.subarray(0, 3)]))).isErr()).toBe(
      true,
    );
    expect((await restarted.chunk(spec, 3, 4, Readable.from([bytes.subarray(3)]))).isOk()).toBe(
      true,
    );
    const first = (await restarted.finish(spec))._unsafeUnwrap();
    assert(first.path !== null);
    expect(await readFile(first.path)).toEqual(bytes);
    expect(first.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect((await new UploadFilesystem(dir).finish(spec))._unsafeUnwrap()).toEqual(first);
    expect((await restarted.cancel(spec)).isErr()).toBe(true);
  });
  it("does not acknowledge or publish partial chunks, including crash debris", async () => {
    const { dir, files } = await setup();
    expect((await files.chunk(spec, 0, 7, Readable.from([Buffer.from([1, 2])]))).isErr()).toBe(
      true,
    );
    await writeFile(join(dir, ".uploads", spec.id, "0.dead.partial"), "not committed");
    expect((await new UploadFilesystem(dir).status(spec))._unsafeUnwrap().offset).toBe(0);
    expect((await files.finish(spec)).isErr()).toBe(true);
    expect((await files.chunk(spec, 0, UPLOAD_CHUNK_BYTES + 1, Readable.from([]))).isErr()).toBe(
      true,
    );
  });
  it("rejects a changed identity and never replaces an existing destination", async () => {
    const { dir, files } = await setup();
    await files.status(spec);
    expect((await files.status({ ...spec, name: "other" })).isErr()).toBe(true);
    await writeFile(join(dir, "uploads", spec.id, spec.name), "owned by user");
    await files.chunk(spec, 0, 7, Readable.from([Buffer.alloc(7)]));
    expect((await files.finish(spec)).isErr()).toBe(true);
    expect(await readFile(join(dir, "uploads", spec.id, spec.name), "utf8")).toBe("owned by user");
  });
  it("replays cancellation and fences delayed writes after a runtime restart", async () => {
    const { dir, files } = await setup();
    expect((await files.chunk(spec, 0, 3, Readable.from([Buffer.alloc(3)]))).isOk()).toBe(true);
    expect((await files.cancel(spec)).isOk()).toBe(true);
    const restarted = new UploadFilesystem(dir);
    expect((await restarted.cancel(spec)).isOk()).toBe(true);
    expect((await restarted.chunk(spec, 0, 3, Readable.from([Buffer.alloc(3)]))).isErr()).toBe(
      true,
    );
    expect((await restarted.finish(spec)).isErr()).toBe(true);
  });

  it("recovers publication before completion metadata and handles empty files", async () => {
    const { dir, files } = await setup();
    const empty = { ...spec, size: 0 };
    await files.status(empty);
    await writeFile(join(dir, "uploads", spec.id, spec.name), Buffer.alloc(0));
    const done = (await files.finish(empty))._unsafeUnwrap();
    expect(done.offset).toBe(0);
    expect((await files.status(empty))._unsafeUnwrap().path).toBe(done.path);
  });
});

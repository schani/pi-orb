import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { NoSimulationTask } from "determined";
import { expect, it } from "vitest";
import { UploadFilesystem } from "../../../orb-runtime/src/uploads/filesystem.ts";
import { makeHarness, makeOrbRow, makeProjectRow } from "../testkit/fixtures.ts";
import { recoverUploads } from "./workspace-uploads.ts";

class FixedClockTask extends NoSimulationTask {
  override wallNow() {
    return 1000;
  }
}

it("does not publish a previously rejected destination just because compute was replaced", async () => {
  const dir = await mkdtemp(join(tmpdir(), "state-machine-uploads-rebind-"));
  try {
    const task = new FixedClockTask("retained upload workspace", false);
    const h = makeHarness();
    h.store.seedProject(makeProjectRow("project"));
    h.store.seedOrb(makeOrbRow("orb", "project", "running"));
    const spec = { id: "a0000000-0000-4000-8000-000000000001", name: "input.bin", size: 3 };
    const bytes = Buffer.from([0, 127, 255]);
    let files = new UploadFilesystem(dir);
    const admitted = (
      await h.store.uploads.admit(task, "orb", spec, task.wallNow())
    )._unsafeUnwrap();
    (await files.chunk(spec, 0, bytes.length, Readable.from([bytes])))._unsafeUnwrap();
    const pending = (
      await h.store.uploads.record(
        task,
        admitted,
        { status: "finalizing", offset: bytes.length },
        task.wallNow(),
      )
    )._unsafeUnwrap();

    // A user-owned destination causes a real no-replace failure, not an injected fault.
    const destination = join(dir, "uploads", spec.id, spec.name);
    await writeFile(destination, "user-owned bytes");
    const rejected = await files.finish(spec);
    assert(rejected.isErr());
    expect(rejected.error.type).toBe("upload_conflict");
    (
      await h.store.uploads.record(task, pending, { error: rejected.error.message }, task.wallNow())
    )._unsafeUnwrap();
    expect(await readFile(destination, "utf8")).toBe("user-owned bytes");

    // Removing the conflict is not an explicit Retry request.
    await rm(destination);
    let finishCalls = 0;
    const runtime = {
      status: () =>
        files.status(spec).mapErr((error) => ({
          type: "upload_transport" as const,
          message: error.message,
        })),
      finish: () => {
        finishCalls++;
        return files.finish(spec).mapErr((error) => ({
          type: "upload_transport" as const,
          message: error.message,
        }));
      },
    };
    (await recoverUploads(task, h.store, runtime, "orb"))._unsafeUnwrap();
    expect(finishCalls).toBe(0);
    const orb = h.store.orbSnapshot("orb");
    assert(orb !== null);
    h.store.seedOrb({ ...orb, hostIncarnation: orb.hostIncarnation + 1 });
    files = new UploadFilesystem(dir);
    (await recoverUploads(task, h.store, runtime, "orb"))._unsafeUnwrap();
    (await recoverUploads(task, h.store, runtime, "orb"))._unsafeUnwrap();
    const outcome = (await h.store.uploads.list(task, "orb"))._unsafeUnwrap()[0];
    expect(
      outcome?.status,
      `replacement issued ${finishCalls} finish request(s) without explicit retry`,
    ).toBe("finalizing");
    expect(h.store.messageSnapshots("orb")).toHaveLength(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

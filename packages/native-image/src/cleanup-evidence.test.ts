import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { type CleanupEvidence, fileCleanupEvidenceWriter } from "./cleanup-evidence.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const evidence: CleanupEvidence = {
  resourceKind: "images",
  target: "projects/project-a/global/images/image-a",
  scope: "global",
  operation: null,
  status: "uncertain",
  errorCode: "CLEANUP_PENDING",
};

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "cleanup-evidence-"));
  directories.push(path);
  return path;
}

it("atomically keeps only the latest allowlisted evidence per exact target", async () => {
  const path = join(await directory(), "cleanup.json");
  const write = fileCleanupEvidenceWriter(path, undefined);
  expect((await write(evidence)).isOk()).toBe(true);
  expect(
    (
      await write({
        ...evidence,
        operation: "operation-1",
        status: "succeeded",
        errorCode: null,
      })
    ).isOk(),
  ).toBe(true);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual([
    {
      ...evidence,
      operation: "operation-1",
      status: "succeeded",
      errorCode: null,
    },
  ]);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});

it.each(["mkdir", "write", "rename"] as const)("maps real %s failure", async (boundary) => {
  const root = await directory();
  const path = join(root, "parent", "cleanup.json");
  if (boundary === "mkdir") await writeFile(join(root, "parent"), "not a directory");
  else {
    await mkdir(join(root, "parent"));
    if (boundary === "write") await mkdir(`${path}.next`);
    else await mkdir(path);
  }

  const result = await fileCleanupEvidenceWriter(path)(evidence);

  expect(result.isErr() && result.error).toEqual({
    type: "cleanup_evidence_write_failed",
    message: "cannot persist native cleanup evidence",
  });
});

it("keeps the file when the Python publisher boundary fails", async () => {
  const path = join(await directory(), "cleanup.json");
  const result = await fileCleanupEvidenceWriter(path, "/missing/release-record")(evidence);

  expect(result.isErr() && result.error).toEqual({
    type: "cleanup_evidence_write_failed",
    message: "cannot publish native cleanup evidence",
  });
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual([evidence]);
});

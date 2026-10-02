import assert from "node:assert/strict";
import { constants, cpSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { guardInstalledStage, sha } from "./stage-guard.mjs";

const oldStage = resolve(
  import.meta.dirname,
  "../../../.context/dedicated-oauth-reauthorization/corrected-2/package-2/staging",
);
const lock = resolve(import.meta.dirname, "package-lock.json");
let directory;
let stage;
let manifest;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "installed-preflight-"));
  stage = join(directory, "staging");
  cpSync(oldStage, stage, { recursive: true, mode: constants.COPYFILE_FICLONE });
  cpSync(lock, join(stage, "package-lock.json"));
  manifest = {
    ...JSON.parse(readFileSync(join(stage, "manifest.json"), "utf8")),
    lockSha: sha(lock),
  };
  writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest));
});
after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("installed guard accepts import-only pi-mcp and verifies SDK constructor identity", async () => {
  const result = await guardInstalledStage(stage, manifest);
  assert.equal(result.sdkPath.startsWith(join(stage, "node_modules")), true);
});

test("installed guard rejects changed bundle hash without root source", async () => {
  await assert.rejects(
    guardInstalledStage(stage, { ...manifest, bundleSha: "0".repeat(64) }),
    /AssertionError|Expected values to be strictly equal/,
  );
});

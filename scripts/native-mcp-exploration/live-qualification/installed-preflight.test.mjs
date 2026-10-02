import assert from "node:assert/strict";
import { constants, cpSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { guardInstalledStage } from "./stage-guard.mjs";

const installedStage = process.env.STAGED_INITIAL_AUTH;
assert.ok(installedStage, "STAGED_INITIAL_AUTH must name a clean-installed qualification stage");
let directory;
let stage;
let manifest;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "installed-preflight-"));
  stage = join(directory, "staging");
  cpSync(installedStage, stage, { recursive: true, mode: constants.COPYFILE_FICLONE });
  manifest = JSON.parse(readFileSync(join(stage, "manifest.json"), "utf8"));
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

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { guardInstalledStage, sha } from "./stage-guard.mjs";

const stage = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(stage, "manifest.json"), "utf8"));
const installed = await guardInstalledStage(stage, manifest);
const result = spawnSync(process.execPath, ["--test", "initial-auth.test.mjs"], {
  cwd: stage,
  encoding: "utf8",
  timeout: 30_000,
  env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "", STAGED_INITIAL_AUTH: stage },
});
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
assert.equal(result.status, 0, "isolated initial-auth fixture failed");
assert.match(result.stdout, /ℹ pass 1\b/);
console.log(
  JSON.stringify({
    phase: "preflight",
    status: "pass",
    installed,
    patchHashes: manifest.patches.map((p) => p.archiveSha),
    bundleSha: sha(join(stage, "initial-auth.mjs")),
    testCount: 1,
  }),
);

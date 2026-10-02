import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { guard } from "./iap-read-guard.mjs";

const stage = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(stage, "manifest.json")));
const result = await guard(stage);
const tests = spawnSync(process.execPath, ["--test", "iap-read.test.mjs"], {
  cwd: stage,
  encoding: "utf8",
  timeout: 30_000,
  env: { ...process.env, STAGED_IAP_READ: stage, NODE_PATH: "", NODE_OPTIONS: "" },
});
assert.equal(tests.status, 0, "IAP read fence tests failed");
assert.match(tests.stdout, /ℹ pass 3\b/);
console.log(
  JSON.stringify({
    phase: "preflight",
    ...result,
    bundleSha: manifest.files["iap-read.mjs"],
    testCount: 3,
  }),
);

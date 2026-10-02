import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { guard } from "./glideos-read-guard.mjs";

const stage = dirname(fileURLToPath(import.meta.url));
const result = await guard(stage);
const tests = spawnSync(process.execPath, ["--test", "glideos-read.test.mjs"], {
  cwd: stage,
  encoding: "utf8",
  timeout: 30_000,
  env: { ...process.env, STAGED_GLIDEOS_READ: stage, NODE_PATH: "", NODE_OPTIONS: "" },
});
assert.equal(tests.status, 0, `GlideOS read tests failed: ${tests.stderr}`);
assert.match(tests.stdout, /ℹ pass 4\b/);
console.log(JSON.stringify({ phase: "preflight", ...result, testCount: 4 }));

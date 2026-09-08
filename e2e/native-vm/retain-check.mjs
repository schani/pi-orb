import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { waitFor } from "../harness.ts";

const f = JSON.parse(readFileSync(".context/native-vm/fixture.json", "utf8"));
const stage = process.argv[2];
assert.match(stage, /^[a-z0-9-]+$/);
const health = await waitFor(
  "native runtime ready after lifecycle operation",
  async () => {
    const response = await fetch(`${f.runtimeUrl}/v1/health`);
    const value = await response.json();
    assert.notEqual(value.status, "failed", JSON.stringify(value));
    return value.status === "ready" && value.activity === "idle" ? value : null;
  },
  { timeoutMs: 240000 },
);
const path = ".context/native-vm/retention-baseline.json";
if (stage === "baseline") writeFileSync(path, JSON.stringify(health, null, 2));
else {
  const baseline = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(health.sessionId, baseline.sessionId);
  assert.equal(health.checkoutCommit, baseline.checkoutCommit);
  assert.notEqual(health.runtimeInstanceId, baseline.runtimeInstanceId);
  assert.equal(health.hooks.setup.outcome, "ok");
  assert.equal(health.hooks.resume.outcome, "ok");
}
writeFileSync(`.context/native-vm/health-${stage}.json`, JSON.stringify(health, null, 2));
console.log(`RUNTIME_RETENTION_OK ${stage}`);

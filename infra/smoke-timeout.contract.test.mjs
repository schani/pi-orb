import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const seconds = (source, name) => {
  const match = source.match(new RegExp(`^${name}=\\\\?\\$\\{${name}:-([0-9]+)\\}`, "m"));
  assert(match, `${name} default is missing`);
  return Number(match[1]);
};

test("live smoke deadlines cover native lifecycle bounds", () => {
  const smoke = readFileSync(new URL("./smoke.sh", import.meta.url), "utf8");
  const running = seconds(smoke, "RUNNING_TIMEOUT");
  const stopped = seconds(smoke, "STOPPED_TIMEOUT");
  const tailnet = seconds(smoke, "TAILNET_TIMEOUT");
  const health = seconds(smoke, "HEALTH_TIMEOUT");
  assert.equal(running, 900);
  assert(seconds(smoke, "OVERALL_TIMEOUT") >= 2 * running + 2 * stopped + tailnet + health);

  const identity = readFileSync(new URL("./smoke-workload-identity.sh", import.meta.url), "utf8");
  const identityRunning = seconds(identity, "RUNNING_TIMEOUT");
  const identityStopped = seconds(identity, "STOPPED_TIMEOUT");
  const ssh = seconds(identity, "SSH_READY_TIMEOUT");
  assert.equal(identityRunning, 900);
  assert(
    seconds(identity, "OVERALL_TIMEOUT") >= 2 * identityRunning + 2 * identityStopped + 2 * ssh,
  );

  const replacement = readFileSync(
    new URL("./smoke-compute-replacement.sh", import.meta.url),
    "utf8",
  );
  assert.match(replacement, /^boot_deadline_seconds=900\b/m);
});

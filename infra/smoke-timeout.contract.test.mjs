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
  assert.equal(running, 900);
  assert(seconds(smoke, "OVERALL_TIMEOUT") >= 2 * running + 2 * stopped);

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

test("preview health is mandatory and uses an owned peer instead of runner tailnet credentials", () => {
  const smoke = readFileSync(new URL("./smoke-workload-identity.sh", import.meta.url), "utf8");
  assert.match(smoke, /sudo python3 - \/usr\/bin\/tailscale/);
  assert.match(smoke, /< "\$DIR\/smoke_preview\.py"/);
  assert.match(smoke, /preview_deadline=\$\(\( \$\(date \+%s\) \+ 60 \)\)/);
  assert.match(smoke, /fail "peer-preview"/);
  assert.match(smoke, /\.status == "ready"/);
});

test("ops API bearer travels through stdin, not curl arguments", () => {
  const api = readFileSync(new URL("./api.sh", import.meta.url), "utf8");
  assert.match(api, /printf 'header = "Authorization: Bearer %s"/);
  assert.match(api, /curl -s -K - -X/);
  assert.doesNotMatch(api, /curl[^\n]*Authorization: Bearer/);
});

test("compute replacement SSH always uses IAP", () => {
  const replacement = readFileSync(
    new URL("./smoke-compute-replacement.sh", import.meta.url),
    "utf8",
  );
  const sshCommands = replacement.match(/gcloud compute ssh/g) ?? [];
  const iapFlags = replacement.match(/--tunnel-through-iap/g) ?? [];
  assert(sshCommands.length > 0);
  assert.equal(iapFlags.length, sshCommands.length);
});

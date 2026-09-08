import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { waitFor } from "../../harness.ts";

const root = process.env.NATIVE_INTEGRATION_ROOT ?? ".context/native-vm-integration";
const f = JSON.parse(readFileSync(`${root}/fixture.json`));
const url = `http://127.0.0.1:18100/api/v1/orbs/${f.orbId}`;
const before = await fetch(url).then((r) => r.json());
assert.equal(before.state, "running");
const execute = promisify(execFile);
const listed = await execute("gcloud", [
  "compute",
  "instances",
  "list",
  `--project=${f.gcpProject}`,
  `--filter=labels.pi-orb-integration-orb-id=${f.orbId}`,
  "--format=json",
]);
const instances = JSON.parse(listed.stdout);
assert.equal(instances.length, 1);
const instance = instances[0];
assert.equal(instance.status, "RUNNING");
assert(instance.name.startsWith(`pi-orb-${f.orbId}-i`));
await execute("gcloud", [
  "compute",
  "instances",
  "simulate-maintenance-event",
  instance.name,
  `--project=${f.gcpProject}`,
  `--zone=${f.zone}`,
  "--quiet",
]);
const states = [];
await waitFor(
  "preemption recovery",
  async () => {
    const r = await fetch(url).then((r) => r.json());
    if (states.at(-1)?.stateVersion !== r.stateVersion) {
      states.push(r);
      writeFileSync(`${root}/preemption-states.json`, JSON.stringify(states, null, 2));
    }
    return r.state === "running" && r.stateVersion > before.stateVersion ? r : null;
  },
  { timeoutMs: 900000, intervalMs: 2000 },
);
assert(states.some((r) => r.state === "starting"));
console.log("REAL_SPOT_PREEMPTION_RECOVERED");

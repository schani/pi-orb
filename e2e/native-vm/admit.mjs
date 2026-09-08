import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { api, fakeControl, waitFor } from "../harness.ts";

const fixture = JSON.parse(readFileSync(".context/native-vm/fixture.json", "utf8"));
const base = "http://127.0.0.1:18100";
await waitFor("control plane listening", async () => {
  const response = await fetch(`${base}/api/v1/projects`);
  return response.ok ? true : null;
});
const project = await api(base, "POST", "/api/v1/projects", {
  id: fixture.projectId,
  name: "Native VM experiment",
  repositoryUrl: "https://github.com/schani/pi-orb",
});
assert.equal(project.status, 201);
const secret = await api(
  base,
  "PUT",
  `/api/v1/projects/${fixture.projectId}/secrets/NATIVE_VM_SECRET`,
  { value: "fixture-only-value" },
);
assert.equal(secret.status, 200);
const orb = await api(base, "POST", `/api/v1/projects/${fixture.projectId}/orbs`, {
  id: fixture.orbId,
});
assert.equal(orb.status, 202);
const code = await waitFor("device challenge", async () => {
  const { body } = await api(base, "GET", `/api/v1/orbs/${fixture.orbId}`);
  return body.actionRequired?.userCode ?? null;
});
await fakeControl(fixture.fake.sessionKey, "/deviceauth/approve", { user_code: code });
console.log("fixture admitted through device auth");

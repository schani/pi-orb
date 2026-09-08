import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { api, waitFor } from "../../harness.ts";

const root = process.env.NATIVE_INTEGRATION_ROOT ?? ".context/native-vm-integration";
const f = JSON.parse(readFileSync(`${root}/fixture.json`));
const base = "http://127.0.0.1:18100";
assert.equal((await api(base, "DELETE", `/api/v1/projects/${f.projectId}`)).status, 202);
await waitFor(
  "project and orb deleted",
  async () => {
    const project = await api(base, "GET", `/api/v1/projects/${f.projectId}`);
    const orb = await api(base, "GET", `/api/v1/orbs/${f.orbId}`);
    return project.status === 404 && orb.status === 404 ? true : null;
  },
  { timeoutMs: 240000, intervalMs: 2000 },
);
console.log("PROJECT_AND_ORB_DELETED");

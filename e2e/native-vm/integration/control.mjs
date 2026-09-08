import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { api, FatalProbeError, fakeControl, waitFor } from "../../harness.ts";

const root = process.env.NATIVE_INTEGRATION_ROOT ?? ".context/native-vm-integration";
const f = JSON.parse(readFileSync(`${root}/fixture.json`));
const base = "http://127.0.0.1:18100";
const stage = process.argv[2];
await waitFor(
  "isolated control plane listening",
  async () => ((await fetch(`${base}/api/v1/projects`)).ok ? true : null),
  { timeoutMs: 120000 },
);
if (stage === "admit") {
  assert.equal(
    (
      await api(base, "POST", "/api/v1/projects", {
        id: f.projectId,
        name: "Native production integration",
        repositoryUrl: f.repositoryUrl,
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await api(base, "PUT", `/api/v1/projects/${f.projectId}/secrets/NATIVE_VM_SECRET`, {
        value: "fixture-only-value",
      })
    ).status,
    200,
  );
  for (const [name, value] of Object.entries({
    NATIVE_INTEGRATION_GCP_PROJECT: f.gcpProject,
    NATIVE_INTEGRATION_GCP_ZONE: f.zone,
    NATIVE_INTEGRATION_WIF_SERVICE_ACCOUNT: f.wifServiceAccount,
    NATIVE_INTEGRATION_WIF_PROVIDER: f.wifProvider,
  })) {
    assert.equal(typeof value, "string", `${name} missing`);
    assert.equal(
      (
        await api(base, "PUT", `/api/v1/projects/${f.projectId}/secrets/${name}`, {
          value,
        })
      ).status,
      200,
    );
  }
  assert.equal(
    (await api(base, "POST", `/api/v1/projects/${f.projectId}/orbs`, { id: f.orbId })).status,
    202,
  );
  const code = await waitFor("model device challenge", async () => {
    const { body } = await api(base, "GET", `/api/v1/orbs/${f.orbId}`);
    return body.actionRequired?.userCode ?? null;
  });
  await fakeControl(f.fake.sessionKey, "/deviceauth/approve", { user_code: code });
}
if (stage === "stop" || stage === "start" || stage === "fail-start") {
  assert.equal(
    (await api(base, "POST", `/api/v1/orbs/${f.orbId}/${stage === "fail-start" ? "start" : stage}`))
      .status,
    202,
  );
}
if (stage === "delete") {
  assert.equal((await api(base, "DELETE", `/api/v1/projects/${f.projectId}`)).status, 202);
  console.log("project deletion requested");
  process.exit(0);
}
const wanted =
  stage === "stop"
    ? "stopped"
    : stage === "failed" || stage === "fail-start"
      ? "failed"
      : "running";
const row = await waitFor(
  `orb ${wanted}`,
  async () => {
    const { body } = await api(base, "GET", `/api/v1/orbs/${f.orbId}`);
    writeFileSync(`${root}/latest-orb.json`, JSON.stringify(body, null, 2));
    if (body.state === "failed" && wanted !== "failed")
      throw new FatalProbeError(JSON.stringify(body));
    return body.state === wanted ? body : null;
  },
  { timeoutMs: 900000, intervalMs: 2000 },
);
writeFileSync(`${root}/orb-${stage}.json`, JSON.stringify(row, null, 2));
console.log(`INTEGRATION_ORB_${wanted.toUpperCase()} ${stage}`);

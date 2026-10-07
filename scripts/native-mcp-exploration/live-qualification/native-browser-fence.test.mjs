import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fenceRequest,
  fixtureEnvironment,
  translateResponse,
  validateFixture,
} from "./native-browser-fence.mjs";

const fixture = {
  gcpProject: "playground-dev-6ae7",
  zone: "us-central1-a",
  orbId: "11111111-2222-4333-8444-555555555555",
  runtimeImageResource: "projects/playground-dev-6ae7/global/images/runtime-pin",
  workspaceImageResource: "projects/playground-dev-6ae7/global/images/workspace-pin",
};
const prefix = `projects/${fixture.gcpProject}/zones/${fixture.zone}/`;
const instance = `pi-orb-${fixture.orbId}-i0`;
const physical = `pi-orb-validator-${fixture.orbId}-i0`;

test("browser fixture accepts a local origin and rejects non-origin URLs", () => {
  const complete = {
    ...fixture,
    projectId: "11111111-2222-4333-8444-555555555556",
    connectionNonce: "11111111-2222-4333-8444-555555555557",
    connectionMap: "/private/connections.json",
    runtimeImageId: "1",
    workspaceImageId: "2",
    brokerUrl: "http://127.0.0.1:7100",
    appOrigin: "http://127.0.0.1:5173",
    port: 7100,
    gceServiceAccount: "pi-orb-orb-vm@playground-dev-6ae7.iam.gserviceaccount.com",
    subnetwork: "regions/us-central1/subnetworks/pi-orb-us-central1",
    generation: 0,
  };
  validateFixture(complete);
  for (const appOrigin of [
    "http://127.0.0.1:5173/path",
    "http://user@127.0.0.1:5173",
    "http://127.0.0.1:7100",
  ])
    assert.throws(() => validateFixture({ ...complete, appOrigin }));
});

test("fixture env preserves executable workload identity but removes inherited app and fake routing", () => {
  const inherited = {
    PI_ORB_GCP_AUDIENCE: "workload-audience",
    PI_ORB_ID: "runtime-identity",
    PI_ORB_ORIGINAL_IDENTITY_ISSUER: "issuer",
    PI_ORB_ORIGINAL_IDENTITY_SUBJECT: "subject",
    GOOGLE_APPLICATION_CREDENTIALS: "/existing/adc/config",
    PI_ORB_FAKE_OPENAI_INFERENCE_URL: "http://fake-inference",
    PI_ORB_FAKE_OPENAI_OAUTH_URL: "http://fake-oauth",
    PI_ORB_NAME_INFERENCE_URL: "http://fake-name",
    PI_ORB_GITHUB_OAUTH_URL: "http://fake-github",
    PI_ORB_GITHUB_API_URL: "http://fake-github-api",
    PI_ORB_E2E_HOST_SPEC: "fake-spec",
    PI_ORB_E2E_LAUNCH_FAILURE_MARKER: "failure",
    PI_ORB_ROLE: "browser",
    PI_ORB_SECRET_STORE: "gsm",
    PI_ORB_GCE_MACHINE_TYPE: "bad-type",
    DATABASE_URL: "postgres://wrong",
    PORT: "9999",
  };
  const plan = fixtureEnvironment(
    inherited,
    {
      gcpProject: fixture.gcpProject,
      zone: fixture.zone,
      gceServiceAccount: "vm@example.test",
      subnetwork: "fixture-subnet",
      runtimeImageResource: fixture.runtimeImageResource,
      runtimeImageId: "1",
      workspaceImageResource: fixture.workspaceImageResource,
      workspaceImageId: "2",
      brokerUrl: "http://127.0.0.1:7100",
      generation: 0,
      appOrigin: "http://fixture.test:5173",
      port: 7100,
    },
    "/authority",
  );
  assert.equal(plan.PI_ORB_GCP_AUDIENCE, inherited.PI_ORB_GCP_AUDIENCE);
  assert.equal(plan.PI_ORB_ID, inherited.PI_ORB_ID);
  assert.equal(plan.PI_ORB_ORIGINAL_IDENTITY_ISSUER, inherited.PI_ORB_ORIGINAL_IDENTITY_ISSUER);
  assert.equal(plan.PI_ORB_ORIGINAL_IDENTITY_SUBJECT, inherited.PI_ORB_ORIGINAL_IDENTITY_SUBJECT);
  assert.equal(plan.GOOGLE_APPLICATION_CREDENTIALS, inherited.GOOGLE_APPLICATION_CREDENTIALS);
  for (const key of [
    "PI_ORB_FAKE_OPENAI_INFERENCE_URL",
    "PI_ORB_FAKE_OPENAI_OAUTH_URL",
    "PI_ORB_NAME_INFERENCE_URL",
    "PI_ORB_GITHUB_OAUTH_URL",
    "PI_ORB_GITHUB_API_URL",
    "PI_ORB_E2E_HOST_SPEC",
    "PI_ORB_E2E_LAUNCH_FAILURE_MARKER",
  ])
    assert.equal(plan[key], undefined, key);
  assert.equal(plan.PI_ORB_ROLE, undefined);
  assert.equal(plan.PI_ORB_SECRET_STORE, undefined);
  assert.equal(plan.PI_ORB_GCE_MACHINE_TYPE, undefined);
  assert.equal(plan.DATABASE_URL, undefined);
  assert.equal(plan.PORT, "7100");
  assert.equal(plan.PI_ORB_HOST_PROVIDER, "gce");
  assert.equal(plan.PI_ORB_PGLITE_PATH, "/authority/database");
});

test("owned VM insert translates ownership without network tags", () => {
  const req = fenceRequest(fixture, {
    method: "POST",
    path: `${prefix}instances`,
    body: {
      name: instance,
      labels: { "pi-orb-orb-id": fixture.orbId },
      tags: { items: ["untrusted"] },
    },
  });
  assert.equal(req.body.name, physical);
  assert.ok(req.body.name.length <= 63);
  assert.equal(req.path, `${prefix}instances`);
  assert.equal(req.body.labels["pi-orb-orb-id"], undefined);
  assert.equal(req.body.labels["pi-orb-native-browser-orb-id"], fixture.orbId);
  assert.equal(req.body.tags, undefined);
});

test("list is filtered and returned ownership is restored only for owned VM", () => {
  const req = fenceRequest(fixture, { method: "GET", path: `${prefix}instances` });
  assert.equal(req.query, `labels.pi-orb-native-browser-orb-id = "${fixture.orbId}"`);
  const response = translateResponse(fixture, req, {
    items: [{ name: physical, labels: { "pi-orb-native-browser-orb-id": fixture.orbId } }],
  });
  assert.equal(response.items[0].name, instance);
  assert.equal(response.items[0].labels["pi-orb-orb-id"], fixture.orbId);
  const named = fenceRequest(fixture, { method: "GET", path: `${prefix}instances/${instance}` });
  assert.equal(named.path, `${prefix}instances/${physical}`);
  assert.equal(
    translateResponse(fixture, named, {
      name: physical,
      labels: { "pi-orb-native-browser-orb-id": fixture.orbId },
    }).name,
    instance,
  );
  assert.throws(() =>
    translateResponse(fixture, named, {
      name: `pi-orb-validator-${fixture.orbId}-i1`,
      labels: { "pi-orb-native-browser-orb-id": fixture.orbId },
    }),
  );
  assert.throws(() =>
    translateResponse(fixture, req, { items: [{ name: "foreign", labels: {} }] }),
  );
  assert.throws(() =>
    translateResponse(fixture, req, {
      items: [{ name: instance, labels: { "pi-orb-native-browser-orb-id": fixture.orbId } }],
    }),
  );
});

test("rejects foreign operations and accepts only both pinned image reads", () => {
  for (const path of [fixture.runtimeImageResource, fixture.workspaceImageResource])
    assert.equal(fenceRequest(fixture, { method: "GET", path }).path, path);
  for (const args of [
    { method: "GET", path: "projects/production/zones/us-central1-a/instances" },
    { method: "GET", path: `${prefix}instances/pi-orb-foreign` },
    { method: "GET", path: `${prefix}instances/pi-orb-${fixture.orbId}` },
    { method: "GET", path: `${prefix}instances/${physical}` },
    {
      method: "POST",
      path: `${prefix}instances`,
      body: { name: physical, labels: { "pi-orb-orb-id": fixture.orbId } },
    },
    { method: "GET", path: `${prefix}instances/${instance}-extra` },
    { method: "GET", path: `${prefix}instances/pi-orb-${fixture.orbId}-i12345678901234567890` },
    {
      method: "POST",
      path: `${prefix}instances`,
      body: {
        name: `pi-orb-${fixture.orbId}-i12345678901234567890`,
        labels: { "pi-orb-orb-id": fixture.orbId },
      },
    },
    { method: "POST", path: `${prefix}instances`, body: { name: instance, labels: {} } },
    { method: "DELETE", path: `${prefix}disks/pi-orb-data-other` },
    { method: "GET", path: "projects/production/global/images/runtime-pin" },
  ])
    assert.throws(() => fenceRequest(fixture, args), JSON.stringify(args));
  assert.equal(
    fenceRequest(fixture, { method: "POST", path: `${prefix}operations/op/wait` }).path,
    `${prefix}operations/op/wait`,
  );
});

test("cleanup mode permits only read, delete, and operation wait", () => {
  for (const args of [
    { method: "GET", path: fixture.runtimeImageResource },
    { method: "GET", path: `${prefix}instances` },
    { method: "GET", path: `${prefix}disks/pi-orb-data-${fixture.orbId}` },
    { method: "DELETE", path: `${prefix}disks/pi-orb-data-${fixture.orbId}` },
    { method: "DELETE", path: `${prefix}instances/${instance}` },
    { method: "POST", path: `${prefix}operations/op/wait` },
  ])
    assert.equal(fenceRequest(fixture, args, true).method, args.method);
  for (const args of [
    { method: "POST", path: `${prefix}instances/${instance}/start` },
    { method: "POST", path: `${prefix}instances/${instance}/stop` },
    { method: "POST", path: `${prefix}instances`, body: { name: instance } },
    { method: "POST", path: `${prefix}disks`, body: { name: `pi-orb-data-${fixture.orbId}` } },
  ])
    assert.throws(() => fenceRequest(fixture, args, true));
});

test("lifecycle actions stay within the owned instance", () => {
  for (const action of ["start", "stop"]) {
    const path = `${prefix}instances/${instance}/${action}`;
    const mapped = fenceRequest(fixture, { method: "POST", path });
    assert.equal(mapped.action, action);
    assert.equal(mapped.path, `${prefix}instances/${physical}/${action}`);
    assert.throws(() => fenceRequest(fixture, { method: "GET", path }));
    assert.throws(() =>
      fenceRequest(fixture, {
        method: "POST",
        path: `${prefix}instances/pi-orb-foreign/${action}`,
      }),
    );
  }
  for (const method of ["GET", "DELETE"])
    assert.equal(
      fenceRequest(fixture, { method, path: `${prefix}instances/${instance}` }).path,
      `${prefix}instances/${physical}`,
    );
  const guest = `${prefix}instances/${instance}/getGuestAttributes?queryPath=pi-orb%2Fboot%2Fstatus`;
  assert.equal(
    fenceRequest(fixture, { method: "GET", path: guest }).path,
    `${prefix}instances/${physical}/getGuestAttributes?queryPath=pi-orb%2Fboot%2Fstatus`,
  );
  assert.throws(() =>
    fenceRequest(fixture, { method: "POST", path: `${prefix}instances/${instance}/setMetadata` }),
  );
});

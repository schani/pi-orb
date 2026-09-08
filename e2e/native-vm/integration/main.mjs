import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { NoSimulationTask } from "determined";
import { openControlPlaneDatabase } from "../../../apps/control-plane/src/adapters/database.ts";
import { FileSecretStore } from "../../../apps/control-plane/src/adapters/secrets/file-store.ts";

const root = resolve(process.env.NATIVE_INTEGRATION_ROOT ?? ".context/native-vm-integration");
const f = JSON.parse(readFileSync(`${root}/fixture.json`));
const ts = JSON.parse(readFileSync(`${root}/tailscale.json`));
Object.assign(process.env, {
  NATIVE_INTEGRATION_ROOT: root,
  PI_ORB_DATABASE_KIND: "pglite",
  PI_ORB_PGLITE_PATH: `${root}/database`,
  PI_ORB_AUTH_DIR: `${root}/auth`,
  PORT: "18100",
  PI_ORB_HOST_PROVIDER: "gce",
  PI_ORB_GCP_PROJECT: f.gcpProject,
  PI_ORB_GCE_ZONE: f.zone,
  PI_ORB_GCE_SERVICE_ACCOUNT: `pi-orb-orb-vm@${f.gcpProject}.iam.gserviceaccount.com`,
  PI_ORB_GCE_SUBNETWORK: "regions/us-central1/subnetworks/pi-orb-us-central1",
  PI_ORB_GCE_IMAGE_RESOURCE: f.image,
  PI_ORB_GCE_IMAGE_ID: f.imageId,
  PI_ORB_BROKER_URL: f.brokerUrl,
  PI_ORB_HOST_SPEC_GENERATION: String(f.generation),
  PI_ORB_WEB_DIST: resolve("apps/web/dist"),
  PI_ORB_NAME_INFERENCE_URL: f.nameFake.inferenceBaseUrl,
  PI_ORB_FAKE_OPENAI_OAUTH_URL: f.fake.oauthBaseUrl,
  PI_ORB_FAKE_OPENAI_INFERENCE_URL: f.fake.inferenceBaseUrl,
  PI_ORB_TAILSCALE_OAUTH_CLIENT_ID: ts.clientId,
  PI_ORB_TAILSCALE_OAUTH_CLIENT_SECRET: ts.clientSecret,
  PI_ORB_TAILSCALE_TAILNET_DNS_NAME: ts.tailnetDnsName,
  PI_ORB_GITHUB_CLIENT_ID: "integration-seeded-credential",
  PI_ORB_GITHUB_CLIENT_SECRET: "unused-no-refresh",
  PI_ORB_E2E_LAUNCH_FAILURE_MARKER: ".native-integration-fail",
  ...(f.issuerUrl ? { PI_ORB_OIDC_ISSUER_URL: f.issuerUrl } : {}),
});
const db = openControlPlaneDatabase({ kind: "pglite", path: process.env.PI_ORB_PGLITE_PATH });
assert(db.isOk());
const migration = await db.value.migrate();
if (migration.isErr()) {
  console.error("integration database migration failed", migration.error);
  process.exit(1);
}
const task = new NoSimulationTask("integration credentials", false);
const previous = await db.value.pointers.readPointer(task, "github");
assert(previous.isOk());
if (previous.value === null) {
  const credential = JSON.parse(readFileSync(`${root}/github-credential.json`));
  const secret = await new FileSecretStore(`${root}/auth/broker-secrets`).writeSecret(
    task,
    "github",
    credential,
  );
  assert(secret.isOk());
  const pointer = await db.value.pointers.casWritePointer(task, "github", null, {
    generation: 1,
    secretVersion: secret.value.version,
    refreshLeaseUntil: 0,
    lastRefreshAt: 0,
  });
  assert(pointer.isOk());
}
assert((await db.value.close()).isOk());
const apiUrl = new URL("../../../apps/control-plane/src/adapters/gce/api.ts", import.meta.url).href;
const scopedUrl = new URL("./api.mjs", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    const r = nextResolve(specifier, context);
    return r.url === apiUrl ? { ...r, url: scopedUrl } : r;
  },
});
await import("../../../apps/control-plane/src/main.ts");

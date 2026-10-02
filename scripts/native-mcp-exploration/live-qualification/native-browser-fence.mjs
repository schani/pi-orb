import assert from "node:assert/strict";

const OWNER = "pi-orb-native-browser-orb-id";
const ORB = "pi-orb-orb-id";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const instanceNames = (f) => {
  const logical = `pi-orb-${f.orbId}-i`;
  const physical = `pi-orb-validator-${f.orbId}-i`;
  const suffix = (name, prefix) =>
    typeof name === "string" &&
    name.startsWith(prefix) &&
    /^\d+$/.test(name.slice(prefix.length)) &&
    physical.length + name.slice(prefix.length).length <= 63
      ? name.slice(prefix.length)
      : null;
  return { logical, physical, suffix };
};

export function validateFixture(f) {
  assert.match(f.orbId, uuid);
  assert.match(f.projectId, uuid);
  assert.notEqual(f.orbId, "358131f1-a47c-4a6d-9b9a-43e49dd2df7c");
  assert.notEqual(f.projectId, "d9ba991c-85b4-4c19-9a4f-3982e6605090");
  assert.equal(f.gcpProject, "playground-dev-6ae7");
  assert.match(f.zone, /^us-central1-[a-f]$/);
  assert.match(f.connectionNonce, uuid);
  assert.match(f.connectionMap, /^\/[^\n]+$/);
  for (const key of ["runtimeImageResource", "workspaceImageResource"])
    assert.match(f[key], /^projects\/playground-dev-6ae7\/global\/images\/[a-z][-a-z0-9]+$/);
  for (const key of ["runtimeImageId", "workspaceImageId"]) assert.match(f[key], /^[1-9][0-9]*$/);
  assert.equal(f.brokerUrl, "http://127.0.0.1:7100");
  assert.match(f.appOrigin, /^http:\/\/pi-orb-[a-z0-9-]+\.tail[0-9a-f]+\.ts\.net:5173$/);
  assert.equal(f.port, 7100);
  assert.equal(f.gceServiceAccount, `pi-orb-orb-vm@${f.gcpProject}.iam.gserviceaccount.com`);
  assert.equal(f.subnetwork, "regions/us-central1/subnetworks/pi-orb-us-central1");
  assert.equal(f.generation, 0);
}

// Clear only control-plane composition inputs. Workload ADC and Pi identity
// (notably PI_ORB_GCP_AUDIENCE) remain in the inherited environment.
const appConfig = [
  "DATABASE_URL",
  "PI_ORB_ROLE",
  "PI_ORB_IAP_AUDIENCE",
  "PI_ORB_OPS_PRINCIPAL",
  "PI_ORB_RUNTIME_IMAGE",
  "PI_ORB_DOCKER_NETWORK",
  "PI_ORB_PROCESS_STATE_DIR",
  "PI_ORB_SECRET_STORE",
  "PI_ORB_CREDENTIAL_SECRET_PREFIX",
  "PI_ORB_RELEASE_ACTIVATION_BUCKET",
  "PI_ORB_HOSTING_BUCKET",
  "PI_ORB_HOSTING_ORIGIN",
  "PI_ORB_HOSTING_ROOT",
  "PI_ORB_HOSTING_STORE",
  "PI_ORB_OIDC_ISSUER_URL",
  "PI_ORB_WEB_DIST",
  "PI_ORB_GCE_MACHINE_TYPE",
  "PI_ORB_E2E_HOST_SPEC",
  "PI_ORB_E2E_LAUNCH_FAILURE_MARKER",
  "PI_ORB_E2E_RECONCILE_CHECKPOINTS",
  "PI_ORB_FAKE_OPENAI_OAUTH_URL",
  "PI_ORB_FAKE_OPENAI_INFERENCE_URL",
  "PI_ORB_NAME_INFERENCE_URL",
  "PI_ORB_GITHUB_OAUTH_URL",
  "PI_ORB_GITHUB_API_URL",
  "PI_ORB_GITHUB_CLIENT_ID",
  "PI_ORB_GITHUB_CLIENT_SECRET",
  "PI_ORB_TAILSCALE_OAUTH_CLIENT_ID",
  "PI_ORB_TAILSCALE_OAUTH_CLIENT_SECRET",
  "PI_ORB_TAILSCALE_TAILNET_DNS_NAME",
];

export function fixtureEnvironment(inherited, f, state) {
  const next = { ...inherited };
  for (const key of appConfig) delete next[key];
  return Object.assign(next, {
    PI_ORB_DATABASE_KIND: "pglite",
    PI_ORB_PGLITE_PATH: `${state}/database`,
    PI_ORB_AUTH_DIR: `${state}/auth`,
    PI_ORB_HOST_PROVIDER: "gce",
    PI_ORB_GCP_PROJECT: f.gcpProject,
    PI_ORB_GCE_ZONE: f.zone,
    PI_ORB_GCE_SERVICE_ACCOUNT: f.gceServiceAccount,
    PI_ORB_GCE_SUBNETWORK: f.subnetwork,
    PI_ORB_GCE_IMAGE_RESOURCE: f.runtimeImageResource,
    PI_ORB_GCE_IMAGE_ID: f.runtimeImageId,
    PI_ORB_GCE_WORKSPACE_IMAGE_RESOURCE: f.workspaceImageResource,
    PI_ORB_GCE_WORKSPACE_IMAGE_ID: f.workspaceImageId,
    PI_ORB_BROKER_URL: f.brokerUrl,
    PI_ORB_HOST_SPEC_GENERATION: String(f.generation),
    PI_ORB_APP_ORIGIN: f.appOrigin,
    PORT: String(f.port),
  });
}

export function preflightDecision(projectId, orbId, entries) {
  for (const { orbs } of entries)
    assert(
      orbs.every((orb) => orb.hostRef === null),
      "host refs remain: archive before switching provider",
    );
  const owned = entries.find(({ project }) => project.id === projectId);
  if (!owned) return false;
  assert.equal(owned.project.state, "deleting", "test project already exists");
  assert(
    owned.orbs.every((orb) => orb.id === orbId && ["archived", "deleting"].includes(orb.state)),
    "deleting project contains orb outside owned cleanup states",
  );
  return true;
}

export function fenceRequest(f, args, cleanupOnly = false) {
  const prefix = `projects/${f.gcpProject}/zones/${f.zone}/`;
  const imageRead =
    args.method === "GET" && [f.runtimeImageResource, f.workspaceImageResource].includes(args.path);
  assert(imageRead || args.path.startsWith(prefix), "foreign project/zone");
  if (imageRead) return { ...args, kind: "image" };
  const url = new URL(`https://compute.googleapis.com/compute/v1/${args.path}`);
  const segments = url.pathname.slice(`/compute/v1/${prefix}`.length).split("/");
  assert(segments.length <= 3, "unsupported Compute path");
  const [kind, name, action] = segments;
  if (cleanupOnly)
    assert(
      args.method === "GET" ||
        args.method === "DELETE" ||
        (kind === "operations" && args.method === "POST" && action === "wait"),
      "cleanup-only Compute operation",
    );
  const names = instanceNames(f);
  const owned = (n) => names.suffix(n, names.logical) !== null;
  const body = args.body === undefined ? undefined : structuredClone(args.body);
  let query;
  if (kind === "instances") {
    if (name) assert(owned(name), "foreign instance");
    else if (args.method === "GET") query = `labels.${OWNER} = "${f.orbId}"`;
    else assert(args.method === "POST" && owned(body?.name), "foreign insert");
    if (action)
      assert(
        (action === "getGuestAttributes" && args.method === "GET") ||
          (["start", "stop"].includes(action) && args.method === "POST"),
        "instance action",
      );
    else if (name) assert(["GET", "DELETE"].includes(args.method), "instance operation");
    if (args.method === "POST" && !name) {
      assert.equal(body?.labels?.[ORB], f.orbId, "foreign label");
      body.name = names.physical + names.suffix(body.name, names.logical);
      body.labels[OWNER] = f.orbId;
      delete body.labels[ORB];
      delete body.tags;
      body.labels["pi-orb-experiment"] = "native-browser-qualification";
    }
  } else if (kind === "disks") {
    assert.equal(name ?? body?.name, `pi-orb-data-${f.orbId}`, "foreign disk");
    assert(!action && ["GET", "POST", "DELETE"].includes(args.method), "disk operation");
    if (args.method === "POST") {
      assert.equal(body?.labels?.[ORB], f.orbId, "foreign disk label");
      body.labels["pi-orb-experiment"] = "native-browser-qualification";
    }
  } else if (kind === "operations") {
    assert(args.method === "POST" && name && action === "wait", "operation mutation");
  } else assert.fail("unsupported Compute collection");
  const path =
    kind === "instances" && name
      ? `${prefix}instances/${names.physical}${names.suffix(name, names.logical)}${action ? `/${action}` : ""}${url.search}`
      : args.path;
  return {
    ...args,
    path,
    body,
    kind,
    query,
    action,
    logicalName: kind === "instances" ? name : undefined,
  };
}

export function translateResponse(f, req, response) {
  if (req.kind !== "instances" || req.method !== "GET" || req.action || !response || response.error)
    return response;
  const items = req.query ? (response.items ?? []) : [response];
  for (const item of items) {
    assert.equal(item.labels?.[OWNER], f.orbId, "foreign instance response");
    const names = instanceNames(f);
    const suffix = names.suffix(item.name, names.physical);
    assert(suffix !== null, "foreign instance name");
    if (req.logicalName)
      assert.equal(
        item.name,
        names.physical + names.suffix(req.logicalName, names.logical),
        "wrong instance response",
      );
    item.name = names.logical + suffix;
    item.labels[ORB] = f.orbId;
  }
  return response;
}

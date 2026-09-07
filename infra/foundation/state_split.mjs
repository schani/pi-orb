import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { err, ok, Result } from "neverthrow";

export const foundationAddresses = new Set([
  "google_artifact_registry_repository.pi_orb",
  "google_compute_global_address.private_services",
  "google_compute_network.pi_orb",
  "google_compute_subnetwork.orbs",
  "google_compute_subnetwork.run_egress",
  "google_project_iam_member.cp_compute_admin",
  "google_project_iam_member.cp_compute_viewer",
  "google_project_iam_member.cp_log_writer",
  "google_project_iam_member.issuer_log_writer",
  "google_project_iam_member.orb_vm_log_writer",
  "google_service_account.control_plane",
  "google_service_account.issuer",
  "google_service_account.orb_vm",
  "google_service_account_iam_member.cp_uses_orb_vm",
  "google_service_networking_connection.private_services",
]);

export function resourceAddress(resource) {
  return `${resource.module ? `${resource.module}.` : ""}${resource.type}.${resource.name}`;
}

const clone = Result.fromThrowable(
  (value) => structuredClone(value),
  () => ({ type: "state_split_error", code: "invalid_state", message: "state cannot be cloned" }),
);

function indexResources(resources, stateName) {
  const index = new Map();
  for (const resource of resources) {
    const address = resourceAddress(resource);
    if (index.has(address))
      return err({
        type: "state_split_error",
        code: "duplicate_address",
        message: `${stateName} has duplicate address ${address}`,
      });
    index.set(address, resource);
  }
  return ok(index);
}

function sameResource(left, right) {
  return (
    left.mode === right.mode &&
    left.type === right.type &&
    left.name === right.name &&
    left.module === right.module &&
    left.provider === right.provider &&
    JSON.stringify(left.instances) === JSON.stringify(right.instances)
  );
}

function scopeConflict(outputs, scope) {
  for (const [key, expected] of [
    ["project", scope.project],
    ["region", scope.region],
    ["zone", scope.zone],
  ]) {
    if (outputs?.[key] && outputs[key].value !== expected) return key;
  }
  return null;
}

function generatedOutputs(scope) {
  return {
    foundation_schema_version: { value: 0, type: "number" },
    project: { value: scope.project, type: "string" },
    project_number: { value: scope.projectNumber, type: "string" },
    region: { value: scope.region, type: "string" },
    zone: { value: scope.zone, type: "string" },
    state_bucket: { value: scope.stateBucket, type: "string" },
    artifact_registry_repository: {
      value: `projects/${scope.project}/locations/${scope.region}/repositories/pi-orb`,
      type: "string",
    },
    control_plane_service_account_email: {
      value: `pi-orb-control-plane@${scope.project}.iam.gserviceaccount.com`,
      type: "string",
    },
    orb_vm_service_account_email: {
      value: `pi-orb-orb-vm@${scope.project}.iam.gserviceaccount.com`,
      type: "string",
    },
    issuer_service_account_email: {
      value: `pi-orb-issuer@${scope.project}.iam.gserviceaccount.com`,
      type: "string",
    },
    image_builder_service_account_email: {
      value: `pi-orb-image-builder@${scope.project}.iam.gserviceaccount.com`,
      type: "string",
    },
    deployer_service_account_email: {
      value: `pi-orb-amp-deployer@${scope.project}.iam.gserviceaccount.com`,
      type: "string",
    },
    pi_orb_network: {
      value: `projects/${scope.project}/global/networks/pi-orb`,
      type: "string",
    },
    orb_subnetwork: {
      value: `projects/${scope.project}/regions/${scope.region}/subnetworks/pi-orb-${scope.region}`,
      type: "string",
    },
    orb_subnetwork_resource: {
      value: `regions/${scope.region}/subnetworks/pi-orb-${scope.region}`,
      type: "string",
    },
    run_egress_subnetwork: {
      value: `projects/${scope.project}/regions/${scope.region}/subnetworks/pi-orb-run-egress`,
      type: "string",
    },
    run_egress_cidr: { value: "10.10.16.0/26", type: "string" },
  };
}

export function splitState(application, existingFoundation, scope) {
  const appClone = clone(application);
  if (appClone.isErr()) return appClone;
  const foundationClone = existingFoundation ? clone(existingFoundation) : null;
  if (foundationClone?.isErr()) return foundationClone;
  const app = appClone.value;
  const foundation = foundationClone?.value ?? {
    version: application.version,
    terraform_version: application.terraform_version,
    serial: 0,
    lineage: randomUUID(),
    outputs: {},
    resources: [],
    check_results: null,
  };
  const appIndex = indexResources(app.resources, "application state");
  if (appIndex.isErr()) return appIndex;
  const destination = indexResources(foundation.resources, "foundation state");
  if (destination.isErr()) return destination;
  const conflictingScope = scopeConflict(foundation.outputs, scope);
  if (conflictingScope)
    return err({
      type: "state_split_error",
      code: "scope_conflict",
      message: `foundation ${conflictingScope} does not match adoption scope`,
    });

  const moved = [];
  const retained = [];
  for (const resource of app.resources) {
    const address = resourceAddress(resource);
    const move =
      foundationAddresses.has(address) ||
      (resource.type === "google_project_service" && resource.name === "apis");
    if (!move) {
      retained.push(resource);
      continue;
    }
    const present = destination.value.get(address);
    if (present && !sameResource(present, resource))
      return err({
        type: "state_split_error",
        code: "destination_conflict",
        message: `foundation conflict at ${address}`,
      });
    if (!present) foundation.resources.push(resource);
    moved.push(address);
  }
  if (moved.length === 0)
    return err({
      type: "state_split_error",
      code: "empty_source",
      message: "application state contains no foundation resources",
    });
  app.resources = retained;
  app.serial += 1;
  foundation.serial += 1;
  foundation.outputs = { ...generatedOutputs(scope), ...foundation.outputs };

  const inventory = (resources) =>
    [
      ...new Set(
        resources.flatMap((resource) =>
          resource.instances.map(
            (instance) => `${resourceAddress(resource)}=${instance.attributes?.id}`,
          ),
        ),
      ),
    ].sort();
  const before = inventory([...application.resources, ...(existingFoundation?.resources ?? [])]);
  const after = inventory([...app.resources, ...foundation.resources]);
  if (JSON.stringify(before) !== JSON.stringify(after))
    return err({
      type: "state_split_error",
      code: "identity_changed",
      message: "resource identity inventory changed during split",
    });
  return ok({ application: app, foundation, moved: [...new Set(moved)].sort() });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const readJson = Result.fromThrowable(
    (path) => JSON.parse(readFileSync(path, "utf8")),
    () => ({
      type: "state_split_error",
      code: "input_unavailable",
      message: "state split input is unavailable or invalid",
    }),
  );
  const [applicationPath, foundationPath, scopePath] = process.argv.slice(2);
  const application = readJson(applicationPath);
  const foundation = foundationPath === "-" ? ok(null) : readJson(foundationPath);
  const scope = readJson(scopePath);
  const result = application.andThen((app) =>
    foundation.andThen((base) => scope.andThen((values) => splitState(app, base, values))),
  );
  if (result.isErr()) {
    process.stderr.write(`${JSON.stringify(result.error)}\n`);
    process.exitCode = 1;
  } else process.stdout.write(`${JSON.stringify(result.value)}\n`);
}

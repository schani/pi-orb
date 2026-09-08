import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { splitState } from "./state_split.mjs";

const resource = (type, name, id) => ({
  mode: "managed",
  type,
  name,
  provider: "provider",
  instances: [{ schema_version: 0, attributes: { id } }],
});
const scope = { project: "p", projectNumber: "123", region: "r", zone: "z", stateBucket: "b" };

test("projects the project-qualified subnetwork name required by Cloud Run", () => {
  const app = {
    version: 4,
    terraform_version: "1",
    serial: 1,
    lineage: "app",
    outputs: {},
    resources: [resource("google_compute_subnetwork", "run_egress", "subnet")],
  };
  const result = splitState(app, null, scope);
  assert(result.isOk());
  assert.equal(
    result.value.foundation.outputs.run_egress_subnetwork.value,
    "projects/p/regions/r/subnetworks/pi-orb-run-egress",
  );

  const outputs = readFileSync(new URL("./outputs.tf", import.meta.url), "utf8");
  assert.match(
    outputs,
    /output "run_egress_subnetwork" \{ value = google_compute_subnetwork\.run_egress\.id \}/,
  );
  assert.doesNotMatch(
    outputs,
    /output "run_egress_subnetwork" \{ value = google_compute_subnetwork\.run_egress\.self_link \}/,
  );

  const application = readFileSync(new URL("../run.tf", import.meta.url), "utf8");
  assert.equal(application.match(/subnetwork = local\.run_egress_subnetwork/g)?.length, 4);
});

test("moves complete resource objects and preserves every cloud identity", () => {
  const app = {
    version: 4,
    terraform_version: "1",
    serial: 9,
    lineage: "app",
    outputs: {},
    resources: [
      resource("google_service_account", "orb_vm", "sa"),
      resource("google_compute_network", "pi_orb", "network"),
    ],
  };
  const result = splitState(app, null, scope);
  assert(result.isOk());
  const split = result.value;
  assert.deepEqual(split.moved, ["google_compute_network.pi_orb", "google_service_account.orb_vm"]);
  assert.equal(split.application.resources.length, 0);
  assert.deepEqual(
    split.foundation.resources.map((item) => item.instances[0].attributes.id).sort(),
    ["network", "sa"],
  );
  assert.equal(split.application.lineage, "app");
  assert.notEqual(split.foundation.lineage, "app");
});

test("resumes after foundation-first push without duplicating a resource", () => {
  const item = resource("google_service_account", "orb_vm", "sa");
  const app = {
    version: 4,
    terraform_version: "1",
    serial: 2,
    lineage: "app",
    outputs: {},
    resources: [item],
  };
  const foundation = {
    version: 4,
    terraform_version: "1",
    serial: 1,
    lineage: "foundation",
    outputs: {},
    resources: [structuredClone(item)],
  };
  const result = splitState(app, foundation, scope);
  assert(result.isOk());
  const split = result.value;
  assert.equal(split.application.resources.length, 0);
  assert.equal(split.foundation.resources.length, 1);
});

test("fails closed on conflicting destination identity or empty source", () => {
  const app = {
    version: 4,
    terraform_version: "1",
    serial: 2,
    lineage: "app",
    outputs: {},
    resources: [resource("google_service_account", "orb_vm", "one")],
  };
  const foundation = {
    version: 4,
    terraform_version: "1",
    serial: 1,
    lineage: "foundation",
    outputs: {},
    resources: [resource("google_service_account", "orb_vm", "two")],
  };
  assert.equal(splitState(app, foundation, scope)._unsafeUnwrapErr().code, "destination_conflict");
  assert.equal(
    splitState({ ...app, resources: [] }, null, scope)._unsafeUnwrapErr().code,
    "empty_source",
  );
});

test("rejects duplicate addresses and provider conflicts even when IDs match", () => {
  const item = resource("google_service_account", "orb_vm", "same");
  const duplicate = {
    version: 4,
    terraform_version: "1",
    serial: 1,
    lineage: "app",
    outputs: {},
    resources: [item, structuredClone(item)],
  };
  assert.equal(splitState(duplicate, null, scope)._unsafeUnwrapErr().code, "duplicate_address");
  const app = { ...duplicate, resources: [item] };
  const conflicting = {
    version: 4,
    terraform_version: "1",
    serial: 1,
    lineage: "foundation",
    outputs: {},
    resources: [{ ...structuredClone(item), provider: "other" }],
  };
  assert.equal(splitState(app, conflicting, scope)._unsafeUnwrapErr().code, "destination_conflict");
});

test("preserves existing outputs and rejects a foreign foundation scope", () => {
  const item = resource("google_service_account", "orb_vm", "sa");
  const app = {
    version: 4,
    terraform_version: "1",
    serial: 1,
    lineage: "app",
    outputs: {},
    resources: [item],
  };
  const foundation = {
    version: 4,
    terraform_version: "1",
    serial: 1,
    lineage: "foundation",
    outputs: {
      project: { value: "p", type: "string" },
      foundation_schema_version: { value: 1, type: "number" },
      custom: { value: "kept", type: "string" },
    },
    resources: [],
  };
  const result = splitState(app, foundation, scope);
  assert(result.isOk());
  assert.equal(result.value.foundation.outputs.foundation_schema_version.value, 1);
  assert.equal(result.value.foundation.outputs.custom.value, "kept");
  foundation.outputs.project.value = "foreign";
  assert.equal(splitState(app, foundation, scope)._unsafeUnwrapErr().code, "scope_conflict");
});

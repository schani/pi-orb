import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const iam = readFileSync(new URL("./iam.tf", import.meta.url), "utf8");

test("both roots pin Google 8.10.0 in configuration and lockfile", () => {
  for (const root of ["./", "../"]) {
    const main = readFileSync(new URL(`${root}main.tf`, import.meta.url), "utf8");
    const lock = readFileSync(new URL(`${root}.terraform.lock.hcl`, import.meta.url), "utf8");
    assert.match(main, /google = \{\s+source\s+= "opentofu\/google"\s+version = "8\.10\.0"/);
    assert.match(
      lock,
      /provider "registry\.opentofu\.org\/opentofu\/google" \{\s+version\s+= "8\.10\.0"\s+constraints = "8\.10\.0"/,
    );
  }
});

test("both roots inherit provider deletion policies without overriding defaults", () => {
  for (const root of ["./", "../"]) {
    const directory = new URL(root, import.meta.url);
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".tf"))) {
      assert.doesNotMatch(readFileSync(new URL(file, directory), "utf8"), /\bdeletion_policy\s*=/);
    }
  }
});

test("provider upgrade preserves explicit destruction guards", () => {
  const main = readFileSync(new URL("./main.tf", import.meta.url), "utf8");
  const bucket = main.match(/resource "google_storage_bucket" "state" \{[\s\S]*?\n\}/)?.[0];
  assert(bucket);
  assert.match(bucket, /force_destroy\s+= false/);
  assert.match(bucket, /lifecycle \{\s+prevent_destroy = true\s+\}/);
  const sql = readFileSync(new URL("../sql.tf", import.meta.url), "utf8");
  assert.match(sql, /deletion_protection = true/);
  const run = readFileSync(new URL("../run.tf", import.meta.url), "utf8");
  assert.match(run, /deletion_protection\s+= false/);
});

test("Claude subscription parent grants only control-plane version access", () => {
  const claude = readFileSync(new URL("../claude-auth.tf", import.meta.url), "utf8");
  assert.match(claude, /secret_id = "pi-orb-credential-claude-subscription"/);
  assert.match(claude, /replication \{\s+auto \{\}/);
  const bindings = [
    ...claude.matchAll(
      /resource "google_secret_manager_secret_iam_member" "[^"]+" \{([\s\S]*?)\n\}/g,
    ),
  ];
  assert.equal(bindings.length, 2);
  assert.deepEqual(bindings.map((binding) => binding[1].match(/role\s+= "([^"]+)"/)?.[1]).sort(), [
    "roles/secretmanager.secretAccessor",
    "roles/secretmanager.secretVersionManager",
  ]);
  for (const binding of bindings) {
    assert.match(binding[1], /secret_id = google_secret_manager_secret\.claude_subscription\.id/);
    assert.match(binding[1], /member\s+= "serviceAccount:\$\{local\.control_plane_email\}"/);
  }
  assert.doesNotMatch(
    claude,
    /google_secret_manager_secret_version"|secret_data|allUsers|allAuthenticatedUsers|orb_vm|issuer/,
  );
});

test("recurring firewall authority excludes the foundation build firewall", () => {
  const block = iam.match(
    /resource "google_project_iam_member" "deployer_application_firewalls" \{[\s\S]*?\n\}/,
  )?.[0];
  assert(block);
  assert.match(block, /roles\/compute\.securityAdmin/);
  assert.match(block, /global\/firewalls\/pi-orb-iap-to-orb-ssh\\"/);
  assert.doesNotMatch(block, /pi-orb-image-build/);
  assert.doesNotMatch(block, /compute\.googleapis\.com\/(Network|Subnetwork|Address)/);
});

test("foundation plan reader grants exactly seven project reads to only the deployer", () => {
  const roles = [
    ...iam.matchAll(
      /resource "google_project_iam_custom_role" "deployer_foundation_plan_reader" \{([\s\S]*?)\n\}/g,
    ),
  ];
  assert.equal(roles.length, 1);
  const role = roles[0][1];
  assert.match(role, /project\s+= var\.project/);
  assert.match(role, /role_id\s+= "piOrbFoundationPlanReader"/);
  assert.equal([...iam.matchAll(/role_id\s+= "piOrbFoundationPlanReader"/g)].length, 1);
  const permissions = role.match(/permissions\s*= \[([\s\S]*?)\]/)?.[1];
  assert(permissions);
  assert.deepEqual([...permissions.matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort(), [
    "iam.roles.get",
    "iam.serviceAccounts.get",
    "iam.serviceAccounts.getIamPolicy",
    "iam.workloadIdentityPools.get",
    "resourcemanager.projects.getIamPolicy",
    "servicenetworking.services.get",
    "storage.buckets.getIamPolicy",
  ]);
  const members = [
    ...iam.matchAll(
      /resource "google_project_iam_member" "deployer_foundation_plan_reader" \{([\s\S]*?)\n\}/g,
    ),
  ];
  assert.equal(members.length, 1);
  assert.equal(
    [...iam.matchAll(/google_project_iam_custom_role\.deployer_foundation_plan_reader\.name/g)]
      .length,
    1,
  );
  assert.equal(
    members[0][1].trim(),
    [
      "project = var.project",
      "  role    = google_project_iam_custom_role.deployer_foundation_plan_reader.name",
      `  member  = "serviceAccount:\${google_service_account.deployer.email}"`,
    ].join("\n"),
  );
});

test("application IAP administration is absent", () => {
  assert.doesNotMatch(iam, /resource "google_project_iam_member" "deployer_application_iap_admin"/);
});

test("orb smoke can publish only instance SSH metadata", () => {
  const role = iam.match(
    /resource "google_project_iam_custom_role" "deployer_orb_ssh_key_writer" \{[\s\S]*?\n\}/,
  )?.[0];
  assert(role);
  assert.match(role, /permissions = \["compute\.instances\.setMetadata"\]/);
  assert.doesNotMatch(role, /setCommonInstanceMetadata|compute\.projects/);

  const binding = iam.match(
    /resource "google_project_iam_member" "deployer_orb_ssh_key_writer" \{[\s\S]*?\n\}/,
  )?.[0];
  assert(binding);
  assert.match(binding, /compute\.googleapis\.com\/Instance/);
  assert.match(binding, /instances\/pi-orb-/);
  assert.match(binding, /!resource\.name\.startsWith[\s\S]*instances\/pi-orb-builder-/);
  assert.match(binding, /!resource\.name\.startsWith[\s\S]*instances\/pi-orb-validator-/);
});

test("hosting bucket creation is the sole new project-wide storage permission", () => {
  const role = iam.match(
    /resource "google_project_iam_custom_role" "deployer_hosting_bucket_creator" \{[\s\S]*?\n\}/,
  )?.[0];
  assert(role);
  assert.match(role, /permissions = \["storage\.buckets\.create"\]/);
  const binding = iam.match(
    /resource "google_project_iam_member" "deployer_hosting_bucket_creator" \{[\s\S]*?\n\}/,
  )?.[0];
  assert(binding);
  assert.match(
    binding,
    /role\s+= google_project_iam_custom_role\.deployer_hosting_bucket_creator\.name/,
  );
  assert.match(binding, /google_service_account\.deployer\.email/);
  assert.doesNotMatch(binding, /condition/);
});

test("hosting bucket management excludes other buckets and direct object permissions", () => {
  const role = iam.match(
    /resource "google_project_iam_custom_role" "deployer_hosting_bucket_manager" \{[\s\S]*?\n\}/,
  )?.[0];
  assert(role);
  assert.deepEqual([...role.matchAll(/"(storage\.[^"]+)"/g)].map((m) => m[1]).sort(), [
    "storage.buckets.delete",
    "storage.buckets.get",
    "storage.buckets.getIamPolicy",
    "storage.buckets.setIamPolicy",
    "storage.buckets.update",
  ]);
  const binding = iam.match(
    /resource "google_project_iam_member" "deployer_hosting_bucket_manager" \{[\s\S]*?\n\}/,
  )?.[0];
  assert(binding);
  assert.match(
    binding,
    /role\s+= google_project_iam_custom_role\.deployer_hosting_bucket_manager\.name/,
  );
  assert.match(binding, /google_service_account\.deployer\.email/);
  assert(binding.includes('resource.type == \\"storage.googleapis.com/Bucket\\"'));
  assert.match(
    binding,
    /resource\.name == \\"projects\/_\/buckets\/pi-orb-hosting-\$\{var\.project\}\\"/,
  );
  assert.doesNotMatch(binding, /startsWith|\|\|/);
  assert.doesNotMatch(
    iam.match(/deployer_project_roles = toset\(\[[\s\S]*?\]\)/)?.[0] ?? "",
    /roles\/storage\./,
  );
});

test("GitHub admission is the manual main workflow of the exact numeric repository", () => {
  const github = readFileSync(new URL("./github.tf", import.meta.url), "utf8");
  for (const condition of [
    "assertion.repository_id == '1307054237'",
    "assertion.repository_owner_id == '61363'",
    "assertion.ref == 'refs/heads/main'",
    "assertion.event_name == 'workflow_dispatch'",
    "assertion.workflow_ref == 'schani/pi-orb/.github/workflows/deploy.yml@refs/heads/main'",
  ])
    assert(github.includes(condition));
  assert.match(github, /https:\/\/token\.actions\.githubusercontent\.com/);
  assert.match(github, /attribute\.repository_id\/1307054237/);
  assert.match(github, /roles\/iam\.workloadIdentityUser/);
  assert.doesNotMatch(github, /roles\/owner|roles\/editor|allAuthenticatedUsers/);
});

test("blanket recurring network and IAP roles are absent", () => {
  const roles = iam.match(/deployer_project_roles = toset\(\[[\s\S]*?\]\)/)?.[0];
  assert(roles);
  assert.doesNotMatch(roles, /roles\/compute\.networkAdmin|roles\/iap\.admin/);
  assert.doesNotMatch(roles, /roles\/servicenetworking\.networksAdmin/);
});

test("legacy broad network and IAP grants are explicitly adopted for removal", () => {
  const roles = iam.match(/obsolete_deployer_project_roles = toset\(\[[\s\S]*?\]\)/)?.[0];
  assert(roles);
  assert.match(roles, /roles\/compute\.networkAdmin/);
  assert.match(roles, /roles\/iap\.admin/);
  assert.match(roles, /roles\/servicenetworking\.networksAdmin/);
});

test("preview ingress gets zone-scoped DNS and load balancer/certificate authority", () => {
  const main = readFileSync(new URL("./main.tf", import.meta.url), "utf8");
  for (const api of ["certificatemanager", "dns", "domains"])
    assert.match(main, new RegExp(`"${api}\\.googleapis\\.com"`));
  const zone = main.match(/resource "google_dns_managed_zone" "preview" \{[\s\S]*?\n\}/)?.[0];
  assert(zone);
  assert.match(zone, /dns_name\s+= "\$\{var\.preview_domain\}\."/);
  const records = iam.match(
    /resource "google_dns_managed_zone_iam_member" "deployer_preview_records" \{[\s\S]*?\n\}/,
  )?.[0];
  assert(records);
  assert.match(records, /managed_zone = google_dns_managed_zone\.preview\.name/);
  assert.match(records, /roles\/dns\.admin/);
  const roles = iam.match(/deployer_project_roles = toset\(\[[\s\S]*?\]\)/)?.[0];
  assert(roles);
  assert.match(roles, /roles\/certificatemanager\.editor/);
  assert.match(roles, /roles\/compute\.loadBalancerAdmin/);
  assert.doesNotMatch(roles, /roles\/dns\./);
  const variables = readFileSync(new URL("./variables.tf", import.meta.url), "utf8");
  assert.match(variables, /variable "preview_domain" \{[\s\S]*?default\s+= "piorb\.live"/);
});

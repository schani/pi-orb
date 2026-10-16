import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const iam = readFileSync(new URL("./iam.tf", import.meta.url), "utf8");

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

test("rollout reads latest and r-prefixed JSON, preserving activation-only authority", () => {
  const activation = iam.match(
    /resource "google_storage_bucket_iam_member" "control_plane_release_activation" \{[\s\S]*?\n\}/,
  )?.[0];
  assert(activation);
  assert.match(activation, /resource\.name == '[^']*\/static-plane\/releases\/active\.json'/);
  assert.doesNotMatch(activation, /startsWith|matches|\|\|/);
  const rollout = iam.match(
    /resource "google_storage_bucket_iam_member" "control_plane_release_rollout" \{[\s\S]*?\n\}/,
  )?.[0];
  assert(rollout, "missing approved scoped rollout read policy");
  assert.match(rollout, /bucket = var\.state_bucket/);
  assert.match(rollout, /role\s+= "roles\/storage\.objectViewer"/);
  assert.match(
    rollout,
    /member\s+= "serviceAccount:\$\{google_service_account\.control_plane\.email\}"/,
  );
  const releases = "projects/_/buckets/${var.state_bucket}/objects/static-plane/releases";
  assert.equal(
    rollout.match(/expression\s*=\s*"([^"\n]*)"/)?.[1],
    `resource.name == '${releases}/latest.json' || (resource.name.startsWith('${releases}/r-') && resource.name.endsWith('.json'))`,
  );
  assert.doesNotMatch(rollout, /matches|objectAdmin|objectCreator|tfstate|\.tflock|secrets/);
  const expression = rollout.match(/expression\s*=\s*"([^"\n]*)"/)?.[1];
  const terms = expression?.match(
    /^resource\.name == '([^']+)' \|\| \(resource\.name\.startsWith\('([^']+)'\) && resource\.name\.endsWith\('([^']+)'\)\)$/,
  );
  assert(terms);
  const [, latest, prefix, suffix] = terms;
  const bucket = releases.slice(0, releases.indexOf("/objects/"));
  for (const [name, allowed] of [
    [`${releases}/latest.json`, true],
    [`${releases}/r-1791935519-4b99cc0b-7365-4fc7-a485-2a795ca6d660.json`, true],
    [`${releases}/r-example.json`, true],
    [`${releases}/active.json`, false],
    [`${releases}/latest.json.bak`, false],
    [`${releases}/latest.json/other`, false],
    [`${releases}/r-example.txt`, false],
    [`${releases}/r-example.json.bak`, false],
    [`${releases}/other.json`, false],
    [`${releases}/r.json`, false],
    [`${bucket}/objects/static-plane/release.lock`, false],
    [`${releases}/release.lock`, false],
    [`${bucket}/objects/static-plane/default.tfstate`, false],
    [`${bucket}/objects/static-plane/default.tflock`, false],
    [`${bucket}/objects/secrets/r-example.json`, false],
    [`${bucket}/objects/other/releases/latest.json`, false],
    [`${bucket}/objects/other/releases/r-example.json`, false],
    ["projects/_/buckets/foreign/objects/static-plane/releases/latest.json", false],
    ["projects/_/buckets/foreign/objects/static-plane/releases/r-example.json", false],
    [bucket, false],
  ]) {
    assert.equal(
      name === latest || (name.startsWith(prefix) && name.endsWith(suffix)),
      allowed,
      name,
    );
  }
});

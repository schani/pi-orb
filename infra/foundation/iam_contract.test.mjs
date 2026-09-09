import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const iam = readFileSync(new URL("./iam.tf", import.meta.url), "utf8");
const main = readFileSync(new URL("./main.tf", import.meta.url), "utf8");

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

test("recurring IAP administration cannot administer tunnels", () => {
  const block = iam.match(
    /resource "google_project_iam_member" "deployer_application_iap_admin" \{[\s\S]*?\n\}/,
  )?.[0];
  assert(block);
  assert.match(block, /resource\.type == \\"iap\.googleapis\.com\/WebService\\"/);
  assert.doesNotMatch(block, /resource\.name/);
  assert.doesNotMatch(block, /iap_tunnel/);
});

test("release SSH authority is limited to port 22 in build and orb subnets", () => {
  const block = iam.match(
    /resource "google_project_iam_member" "deployer_iap_tunnel" \{[\s\S]*?\n\}/,
  )?.[0];
  assert(block);
  assert.match(block, /destination\.port == 22/);
  assert.match(block, /image_build = \[local\.image_build_ipv4_prefix\]/);
  assert.match(block, /orb_0_7\s+= slice\(local\.orb_ipv4_prefixes, 0, 8\)/);
  assert.match(block, /orb_8_15\s+= slice\(local\.orb_ipv4_prefixes, 8, 16\)/);
  assert.match(block, /for prefix in each\.value/);
  assert.match(main, /image_build_ipv4_prefix\s+= "10\.11\.0\."/);
  assert.match(main, /orb_ipv4_cidr\s+= "10\.10\.0\.0\/20"/);
  assert.match(main, /orb_ipv4_prefixes\s+= \[for octet in range\(16\)/);

  // IAM Conditions permit at most 12 logical operators. Each rendered
  // binding has one port conjunction plus at most seven prefix disjunctions.
  const scopes = [
    ["10.11.0."],
    ...[0, 8].map((start) => Array.from({ length: 8 }, (_, offset) => `10.10.${start + offset}.`)),
  ];
  assert.equal(scopes.flat().length, 17);
  assert.equal(new Set(scopes.flat()).size, 17);
  assert(scopes.every((prefixes) => prefixes.length <= 8));
  assert(scopes.every((prefixes) => 1 + Math.max(0, prefixes.length - 1) <= 12));
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

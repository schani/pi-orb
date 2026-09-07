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
  assert.match(block, /local\.image_build_ipv4_prefix/);
  assert.match(block, /local\.orb_ipv4_prefixes/);
  assert.match(main, /orb_ipv4_cidr\s+= "10\.10\.0\.0\/20"/);
  assert.match(main, /orb_ipv4_prefixes\s+= \[for octet in range\(16\)/);
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

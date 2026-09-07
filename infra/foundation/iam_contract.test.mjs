import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const iam = readFileSync(new URL("./iam.tf", import.meta.url), "utf8");

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

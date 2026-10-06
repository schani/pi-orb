import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("identity deployment contract", () => {
  it("uses Google authentication and immutable machine subject on the surviving issuer", () => {
    const run = readFileSync(resolve("infra/run.tf"), "utf8");
    expect(
      [...run.matchAll(/resource "google_cloud_run_v2_service" "([^"]+)"/gu)].map(
        (match) => match[1],
      ),
    ).toEqual(["issuer"]);
    expect(run).toMatch(/PI_ORB_AUTH_MODE"\s+value = "google"/u);
    expect(run).toContain("var.machine_subject");
    expect(run).toContain("local.control_plane_email");
    expect(run).not.toMatch(/PI_ORB_ROLE|PI_ORB_IAP_AUDIENCE|PI_ORB_OPS_PRINCIPAL/u);
    expect(run).toContain("google_logging_project_exclusion.google_callback");
  });

  it("references pinned auth secret versions without bringing payloads into Terraform", () => {
    const auth = readFileSync(resolve("infra/auth.tf"), "utf8");
    expect(auth).toContain('data "google_secret_manager_secret" "auth"');
    expect(auth).toContain('toset(["google_client_secret", "cookie_secret"])');
    expect(auth).toContain('role      = "roles/secretmanager.secretAccessor"');
    expect(auth).toMatch(/member\s+= "serviceAccount:\$\{local\.control_plane_email\}"/u);
    expect(auth).not.toMatch(/secret_data|google_secret_manager_secret_version/u);
    const run = readFileSync(resolve("infra/run.tf"), "utf8");
    expect(run).toMatch(
      /for_each = \{ PI_ORB_GOOGLE_CLIENT_SECRET = "google_client_secret", PI_ORB_COOKIE_SECRET = "cookie_secret" \}\s+content \{\s+name = env.key\s+value_source \{\s+secret_key_ref \{\s+secret\s+= data.google_secret_manager_secret.auth\[env.value\].secret_id\s+version = "1"/u,
    );
    for (const source of [auth, run, readFileSync(resolve("infra/variables.tf"), "utf8")])
      expect(source).not.toMatch(/(?:variable\s+"|var\.)(?:google_client_secret|cookie_secret)\b/u);
    const workflow = readFileSync(resolve(".github/workflows/deploy.yml"), "utf8");
    expect(workflow).not.toMatch(/TF_VAR_(?:google_client_secret|cookie_secret)\b/u);
  });
});

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
    const auth = readFileSync(resolve("infra/auth.tf"), "utf8");
    expect(auth).toContain("length(var.cookie_secret) >= 32");
    expect(auth).toContain("google_secret_manager_secret_version");
    expect(run).toContain("google_logging_project_exclusion.google_callback");
  });
});

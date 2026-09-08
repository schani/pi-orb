import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("hosted-file cloud infrastructure", () => {
  it("owns a private non-retaining bucket for hosted bytes", () => {
    const hosting = readFileSync(resolve("infra/hosting.tf"), "utf8");

    expect(hosting).toMatch(/resource "google_storage_bucket" "hosting"/);
    expect(hosting).toMatch(/public_access_prevention\s+=\s+"enforced"/);
    expect(hosting).toMatch(/uniform_bucket_level_access\s+=\s+true/);
    expect(hosting).toMatch(/force_destroy\s+=\s+false/);
    expect(hosting).toMatch(/versioning\s*{[\s\S]*enabled\s+=\s+false[\s\S]*}/);
    expect(hosting).toMatch(
      /soft_delete_policy\s*{[\s\S]*retention_duration_seconds\s+=\s+0[\s\S]*}/,
    );
    expect(hosting).not.toContain("retention_policy");
  });

  it("grants the browser and runtime identity object access", () => {
    const hosting = readFileSync(resolve("infra/hosting.tf"), "utf8");

    expect(hosting).toMatch(
      /resource "google_storage_bucket_iam_member" "control_plane_hosting_objects"[\s\S]*role\s+=\s+"roles\/storage\.objectAdmin"[\s\S]*member\s+=\s+"serviceAccount:\$\{local\.control_plane_email\}"/,
    );
  });

  it("configures both serving roles with one store and isolated files origin", () => {
    const hosting = readFileSync(resolve("infra/hosting.tf"), "utf8");
    const run = readFileSync(resolve("infra/run.tf"), "utf8");
    const outputs = readFileSync(resolve("infra/outputs.tf"), "utf8");

    expect(hosting).toMatch(
      /app_origin\s+=\s+"https:\/\/\$\{local\.browser_service_name\}-\$\{local\.foundation\.project_number\}\.\$\{var\.region\}\.run\.app"/,
    );
    expect(hosting).toMatch(
      /hosting_origin\s+=\s+"https:\/\/files---\$\{local\.browser_service_name\}/,
    );
    expect(run).toMatch(/name\s+=\s+local\.browser_service_name/);
    expect(run).toMatch(
      /traffic\s*{[\s\S]*type\s+=\s+"TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"[\s\S]*percent\s+=\s+100[\s\S]*tag\s+=\s+"files"/,
    );
    expect(run).toMatch(/hosting_env\s*=\s*{[\s\S]*PI_ORB_HOSTING_STORE\s*=\s*"gcs"/);
    expect(run).toMatch(/PI_ORB_HOSTING_BUCKET\s*=\s*google_storage_bucket\.hosting\.name/);
    expect(run).toMatch(/PI_ORB_HOSTING_ORIGIN\s*=\s*local\.hosting_origin/);
    expect(run).toMatch(/contains\(self\.urls, local\.app_origin\)/);
    expect(run).not.toContain("self.traffic_statuses");
    expect(run).toMatch(/PI_ORB_APP_ORIGIN\s*=\s*local\.app_origin/);
    expect(run.match(/for_each\s*=\s*local\.hosting_env/g)).toHaveLength(3);
    expect(outputs).toMatch(/output "hosting_url"[\s\S]*value\s+=\s+local\.hosting_origin/);
    expect(outputs).toMatch(
      /output "browser_url"[\s\S]*value\s+=\s+google_cloud_run_v2_service\.browser\.uri/,
    );
  });
});

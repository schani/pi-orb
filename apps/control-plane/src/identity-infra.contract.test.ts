import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("identity deployment contract", () => {
  it("configures direct-run IAP audience only on browser and fixed debug principal on ops", () => {
    const run = readFileSync(resolve("infra/run.tf"), "utf8");
    expect(run).toContain('name  = "PI_ORB_IAP_AUDIENCE"');
    expect(run).toContain(
      'value = "/projects/$' +
        "{local.foundation.project_number}/locations/$" +
        "{var.region}/services/$" +
        '{local.browser_service_name}"',
    );
    expect(run).toContain('name  = "PI_ORB_OPS_PRINCIPAL"');
    expect(run).toContain(
      'value = "serviceAccount:pi-orb-debug@$' + '{var.project}.iam.gserviceaccount.com"',
    );
    expect(run.match(/PI_ORB_IAP_AUDIENCE/gu)).toHaveLength(1);
    expect(run.match(/PI_ORB_OPS_PRINCIPAL/gu)).toHaveLength(1);
  });
});

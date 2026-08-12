import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkTestLaunchFailure } from "./test-launch-failure.ts";

describe("checkTestLaunchFailure", () => {
  it("fails only the armed orb incarnation and durably records the injection", () => {
    const workDir = mkdtempSync(join(tmpdir(), "pi-orb-launch-failure-"));
    writeFileSync(
      join(workDir, ".pi-orb-e2e-launch-failure.json"),
      JSON.stringify({ orbId: "orb-1", incarnation: 2 }),
    );
    const env = {
      PI_ORB_E2E_LAUNCH_FAILURE_MARKER: ".pi-orb-e2e-launch-failure.json",
      PI_ORB_ID: "orb-1",
      PI_ORB_HOST_INCARNATION: "2",
    };

    expect(checkTestLaunchFailure(env, workDir)).toEqual({ inject: true });
    expect(checkTestLaunchFailure(env, workDir)).toEqual({ inject: true });
    expect(
      readFileSync(join(workDir, ".pi-orb-e2e-launch-failure-events.jsonl"), "utf8"),
    ).toContain('"orbId":"orb-1","incarnation":2');
    expect(checkTestLaunchFailure({ ...env, PI_ORB_HOST_INCARNATION: "3" }, workDir)).toEqual({
      inject: false,
    });
  });

  it("is inert unless explicitly enabled and fails open on malformed test state", () => {
    const workDir = mkdtempSync(join(tmpdir(), "pi-orb-launch-failure-"));
    expect(checkTestLaunchFailure({}, workDir)).toEqual({ inject: false });
    writeFileSync(join(workDir, "bad.json"), "not-json");
    expect(
      checkTestLaunchFailure(
        {
          PI_ORB_E2E_LAUNCH_FAILURE_MARKER: "bad.json",
          PI_ORB_ID: "orb-1",
          PI_ORB_HOST_INCARNATION: "0",
        },
        workDir,
      ),
    ).toMatchObject({ inject: false, error: expect.stringContaining("test launch-failure seam") });
  });
});

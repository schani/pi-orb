import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { preserveMultiUserEvidence } from "./multi-user-evidence.ts";

describe("multi-user failure evidence", () => {
  it("retains every diagnostic channel before fixture teardown", () => {
    const root = mkdtempSync(join(tmpdir(), "multi-user-evidence-unit-"));
    try {
      preserveMultiUserEvidence(root, {
        controlPlaneLog: "resource_acquisition_failed\n",
        inference: [{ owner: "alice", body: "ALICE_MODEL_IDENTITY" }],
        github: [{ path: "/login/oauth/access_token", owner: "alice", approved: true }],
        orbs: [{ id: "alice-orb", state: "failed" }],
        sessions: { alice: { requests: [] }, bob: { error: "ledger unavailable" } },
      });
      expect(readFileSync(join(root, "control-plane.log"), "utf8")).toBe(
        "resource_acquisition_failed\n",
      );
      expect(JSON.parse(readFileSync(join(root, "diagnostics.json"), "utf8"))).toEqual({
        inference: [{ owner: "alice", body: "ALICE_MODEL_IDENTITY" }],
        github: [{ path: "/login/oauth/access_token", owner: "alice", approved: true }],
        orbs: [{ id: "alice-orb", state: "failed" }],
        sessions: { alice: { requests: [] }, bob: { error: "ledger unavailable" } },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

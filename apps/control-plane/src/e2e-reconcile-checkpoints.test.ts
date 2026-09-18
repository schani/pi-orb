import { describe, expect, it } from "vitest";
import { E2eReconcileCheckpoints } from "./e2e-reconcile-checkpoints.ts";

describe("E2E reconciliation checkpoints", () => {
  it("does not accept a pass completed before the request", () => {
    const checkpoints = new E2eReconcileCheckpoints();
    expect(checkpoints.complete("orb", 0)).toEqual([]);
    checkpoints.request("orb", "request", 1);
    expect(checkpoints.complete("orb", 0)).toEqual([]);
    expect(checkpoints.complete("orb", 1)).toEqual(["request"]);
  });

  it("accepts a later generation after another legitimate nudge", () => {
    const checkpoints = new E2eReconcileCheckpoints();
    checkpoints.request("orb", "first", 2);
    checkpoints.request("orb", "second", 3);
    expect(checkpoints.complete("orb", 3)).toEqual(["first", "second"]);
    expect(checkpoints.complete("orb", 4)).toEqual([]);
  });
});

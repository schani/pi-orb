import { OrbViewSchema } from "@pi-orb/protocol";
import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { ControlState } from "../domain/control-state.ts";
import type { OrbRow } from "../domain/orb.ts";
import { orbView } from "./views.ts";

const orb: OrbRow = {
  id: "orb-1",
  projectId: "proj-1",
  name: "Reconnect Repair",
  autoNameLeaseUntil: null,
  autoNameAttempts: 0,
  autoNameNextAttemptAt: null,
  state: "running",
  stateVersion: 3,
  hostKind: "gce",
  hostRef: "pi-orb-orb-1",
  checkoutCommit: "abc123",
  harnessSessionId: null,
  harnessSessionHeader: null,
  lastError: null,
  runtimeTokenHash: null,
  replicationCursor: null,
  replicatedHeadId: null,
  lastBusyAt: null,
  stopReason: null,
  stateChangedAt: 1_700_000_000_000,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

describe("orbView failures", () => {
  it("exposes the durable explanation without a transitional readiness detail", () => {
    const view = orbView(
      {
        ...orb,
        state: "failed",
        checkoutCommit: null,
        lastError: "runtime_failed: clone_failed: repository access denied",
      },
      new ControlState(),
      {},
    );

    expect(view.lastError).toBe("runtime_failed: clone_failed: repository access denied");
    expect(view.stateDetail).toBeUndefined();
    expect(Check(OrbViewSchema, view)).toBe(true);
  });
});

describe("orbView activity", () => {
  it("exposes the latest observed activity for a running orb", () => {
    const control = new ControlState();
    control.recordPullSuccess(orb.id, 123, "busy", "runtime-1");

    const view = orbView(orb, control, {});

    expect(view.activity).toBe("busy");
    expect(Check(OrbViewSchema, view)).toBe(true);
  });

  it("omits activity when it is unknown or the orb is not running", () => {
    const control = new ControlState();
    expect(orbView(orb, control, {}).activity).toBeUndefined();

    control.recordPullSuccess(orb.id, 123, "busy", "runtime-1");
    const stopped = orbView({ ...orb, state: "stopped" }, control, {});
    expect(stopped.activity).toBeUndefined();
    expect("activity" in stopped).toBe(false);
  });
});

describe("orbView previewHost", () => {
  it("derives the MagicDNS host when a tailnet is configured", () => {
    const view = orbView(orb, new ControlState(), { tailnetDnsName: "tailabc123.ts.net" });
    expect(view.previewHost).toBe("pi-orb-orb-1.tailabc123.ts.net");
    expect(Check(OrbViewSchema, view)).toBe(true);
  });

  it("omits the field entirely when port exposure is off", () => {
    const view = orbView(orb, new ControlState(), {});
    expect(view.previewHost).toBeUndefined();
    expect("previewHost" in view).toBe(false);
    expect(Check(OrbViewSchema, view)).toBe(true);
  });
});

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
  hostIncarnation: 0,
  hostSpecFingerprint: null,
  hostSpecGeneration: null,
  hostDiscardThroughIncarnation: null,
  hostDiscardReason: null,
  hostDiscardError: null,
  hostDiscardEvidence: null,
  hostDiscardRequestedAt: null,
  checkoutCommit: "abc123",
  harnessSessionId: null,
  harnessSessionHeader: null,
  lastError: null,
  runtimeTokenHash: null,
  replicationCursor: null,
  replicatedHeadId: null,
  lastBusyAt: null,
  stopReason: null,
  mintFailureCode: null,
  mintFailureAt: null,
  lastMintAt: null,
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

describe("orbView compute discard", () => {
  it("shows durable cleanup progress without replacing the original failure", () => {
    const view = orbView(
      {
        ...orb,
        state: "failed",
        lastError: "runtime_failed: process exited",
        hostDiscardThroughIncarnation: 0,
        hostDiscardReason: "failed",
        hostDiscardError: "provider temporarily unavailable",
        hostDiscardRequestedAt: 1_700_000_001_000,
      },
      new ControlState(),
      {},
    );

    expect(view.lastError).toBe("runtime_failed: process exited");
    expect(view.stateDetail).toEqual({
      type: "discarding_failed_compute",
      retrying: true,
      message: "provider temporarily unavailable",
    });
    expect(Check(OrbViewSchema, view)).toBe(true);
  });

  it("reports a spec replacement as routine hygiene, never as a failure", () => {
    // Same durable columns, different reason: a deploy replacing stale
    // compute must not tell the user their orb failed
    // (docs/compute-replacement.md).
    const view = orbView(
      {
        ...orb,
        state: "starting",
        hostDiscardThroughIncarnation: 0,
        hostDiscardReason: "host_spec_changed",
        hostDiscardError: "compute.instances.delete rate limited",
        hostDiscardRequestedAt: 1_700_000_001_000,
      },
      new ControlState(),
      {},
    );

    expect(view.stateDetail).toEqual({
      type: "replacing_stale_compute",
      retrying: true,
      message: "compute.instances.delete rate limited",
    });
    expect(Check(OrbViewSchema, view)).toBe(true);
  });

  it("omits the cleanup message while disposal is progressing normally", () => {
    const replacing = orbView(
      {
        ...orb,
        state: "starting",
        hostDiscardThroughIncarnation: 0,
        hostDiscardReason: "host_spec_changed",
        hostDiscardRequestedAt: 1_700_000_001_000,
      },
      new ControlState(),
      {},
    );
    expect(replacing.stateDetail).toEqual({ type: "replacing_stale_compute", retrying: false });

    const discarding = orbView(
      {
        ...orb,
        state: "failed",
        lastError: "runtime_failed: process exited",
        hostDiscardThroughIncarnation: 0,
        hostDiscardReason: "failed",
        hostDiscardRequestedAt: 1_700_000_001_000,
      },
      new ControlState(),
      {},
    );
    expect(discarding.stateDetail).toEqual({ type: "discarding_failed_compute", retrying: false });
    expect(discarding.lastError).toBe("runtime_failed: process exited");
    expect(Check(OrbViewSchema, replacing)).toBe(true);
    expect(Check(OrbViewSchema, discarding)).toBe(true);
  });
});

describe("orbView boot hooks", () => {
  it("reports a running setup hook instead of a bare readiness wait", () => {
    const control = new ControlState();
    control.recordBootProbe("orb-1", {
      hostState: "running",
      hostRunningSinceWall: Date.now() - 30_000,
      hostRunningSinceMono: 0,
      answered: true,
      setupRunning: true,
      nowMono: 0,
      nowWall: Date.now() - 30_000,
    });
    const view = orbView({ ...orb, state: "starting" }, control, {});
    expect(view.stateDetail).toMatchObject({ type: "running_setup" });
    expect(Check(OrbViewSchema, view)).toBe(true);
  });

  it("falls back to the readiness wait once setup has finished", () => {
    const control = new ControlState();
    for (const setupRunning of [true, false]) {
      control.recordBootProbe("orb-1", {
        hostState: "running",
        hostRunningSinceWall: Date.now(),
        hostRunningSinceMono: 0,
        answered: true,
        setupRunning,
        nowMono: 0,
        nowWall: Date.now(),
      });
    }
    const view = orbView({ ...orb, state: "starting" }, control, {});
    expect(view.stateDetail).toMatchObject({ type: "waiting_for_runtime" });
  });

  it("keeps a running orb's hook failure visible with its log path", () => {
    const control = new ControlState();
    control.noteHookFailure(orb.id, {
      hook: "setup",
      reason: "timeout",
      logPath: "/workspace/home/.cache/pi-orb/logs/setup.log",
    });
    const view = orbView(orb, control, {});
    expect(view.stateDetail).toEqual({
      type: "setup_failed",
      hook: "setup",
      reason: "timeout",
      logPath: "/workspace/home/.cache/pi-orb/logs/setup.log",
    });
    expect(Check(OrbViewSchema, view)).toBe(true);
  });

  it("says nothing about hooks that succeeded", () => {
    const control = new ControlState();
    control.noteHookFailure(orb.id, null);
    expect(orbView(orb, control, {}).stateDetail).toBeUndefined();
  });

  it("says nothing about a hook failure the orb is no longer running on", () => {
    const control = new ControlState();
    control.noteHookFailure(orb.id, {
      hook: "resume",
      reason: "failed",
      logPath: "/workspace/home/.cache/pi-orb/logs/resume.log",
    });
    expect(orbView({ ...orb, state: "stopped" }, control, {}).stateDetail).toBeUndefined();
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

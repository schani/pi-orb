import { OrbViewSchema } from "@pi-orb/protocol";
import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { ControlState } from "../domain/control-state.ts";
import type { OrbRow } from "../domain/orb.ts";
import { orbView } from "./views.ts";

const orb: OrbRow = {
  id: "orb-1",
  projectId: "proj-1",
  harness: "pi",
  name: "Reconnect Repair",
  userTimeZone: null,
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
  lastReadyAt: null,
  harnessSessionId: null,
  harnessSessionHeader: null,
  lastError: null,
  runtimeTokenHash: null,
  replicationCursor: null,
  replicatedHeadId: null,
  unreadAlertId: null,
  lastBusyAt: null,
  uploadActiveUntil: null,
  previewActiveUntil: null,
  stopReason: null,
  sleepId: null,
  sleepUntil: null,
  lastMintAt: null,
  stateChangedAt: 1_700_000_000_000,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

it("exposes a durable preview lease without agent busy", () => {
  const until = 1_700_000_015_000;
  const view = orbView({ ...orb, previewActiveUntil: until }, new ControlState());
  expect(view.previewActiveUntil).toBe(new Date(until).toISOString());
  expect(view.activity).toBeUndefined();
  expect(Check(OrbViewSchema, view)).toBe(true);
});

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

    const view = orbView(orb, control);

    expect(view.activity).toBe("busy");
    expect(Check(OrbViewSchema, view)).toBe(true);
  });

  it("omits activity when it is unknown or the orb is not running", () => {
    const control = new ControlState();
    expect(orbView(orb, control).activity).toBeUndefined();

    control.recordPullSuccess(orb.id, 123, "busy", "runtime-1");
    const stopped = orbView({ ...orb, state: "stopped" }, control);
    expect(stopped.activity).toBeUndefined();
    expect("activity" in stopped).toBe(false);
  });
});

describe("orbView sleep", () => {
  it("shows the deadline and waiting phase", () => {
    const view = orbView({ ...orb, sleepId: "sleep-1", sleepUntil: 20_000 }, new ControlState());
    expect(view.sleepUntil).toBe(new Date(20_000).toISOString());
    expect(view.stateDetail).toEqual({
      type: "waiting_for_sleep",
      sleepUntil: new Date(20_000).toISOString(),
      phase: "waiting_for_idle",
    });
    expect(Check(OrbViewSchema, view)).toBe(true);
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
    const view = orbView({ ...orb, state: "starting" }, control);
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
    const view = orbView({ ...orb, state: "starting" }, control);
    expect(view.stateDetail).toMatchObject({ type: "waiting_for_runtime" });
  });

  it("keeps a running orb's hook failure visible with its log path", () => {
    const control = new ControlState();
    control.noteHookFailure(orb.id, {
      hook: "setup",
      reason: "timeout",
      logPath: "/workspace/home/.cache/pi-orb/logs/setup.log",
    });
    const view = orbView(orb, control);
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
    expect(orbView(orb, control).stateDetail).toBeUndefined();
  });

  it("says nothing about a hook failure the orb is no longer running on", () => {
    const control = new ControlState();
    control.noteHookFailure(orb.id, {
      hook: "resume",
      reason: "failed",
      logPath: "/workspace/home/.cache/pi-orb/logs/resume.log",
    });
    expect(orbView({ ...orb, state: "stopped" }, control).stateDetail).toBeUndefined();
  });
});

describe("orbView workload identity", () => {
  it("says nothing about minting at all", () => {
    // Mint outcomes are not durable state and never reach the browser
    // (docs/workload-identity.md): the party who can act on a denial is the
    // caller inside the orb, which got the typed error, and the operator's
    // record is the deduplicated `identity-mint-denied` log edge.
    const view = orbView({ ...orb, lastMintAt: 1_700_000_060_000 }, new ControlState());
    expect(Object.keys(view)).not.toContain("identity");
    expect(JSON.stringify(view)).not.toContain("mint");
    expect(Check(OrbViewSchema, view)).toBe(true);
  });
});

describe("orbView credential challenge shaping", () => {
  const owner = "00000000-0000-4000-8000-000000000001";
  const coworker = "00000000-0000-4000-8000-000000000002";
  const challenge = {
    provider: "github" as const,
    verificationUri: "https://github.test/device",
    userCode: "SECRET-CODE",
    expiresAt: 1_700_000_060_000,
  };

  it("shows Claude connection only to the owner without exposing native credentials", () => {
    const control = new ControlState();
    control.markAuthBlocked(orb.id, owner, "claude");
    control.setChallenge(owner, {
      provider: "claude",
      verificationUri: "",
      userCode: "",
      expiresAt: 1_700_000_060_000,
    });
    const row = { ...orb, harness: "claude" as const, state: "starting" as const };
    const view = orbView(row, control, owner);
    expect(view.harness).toBe("claude");
    expect(view.actionRequired?.type).toBe("claude_subscription_login");
    expect(Check(OrbViewSchema, view)).toBe(true);
    expect(orbView(row, control, null).actionRequired).toEqual({
      type: "owner_login_required",
      provider: "claude",
    });
    for (const field of ["runtimeTokenHash", "harnessSessionId", "hostRef"])
      expect(view).not.toHaveProperty(field);
  });

  it("shows codes only to the project owner", () => {
    const control = new ControlState();
    control.markAuthBlocked(orb.id, owner);
    control.setChallenge(owner, challenge);
    expect(orbView({ ...orb, state: "starting" }, control, owner).actionRequired).toMatchObject({
      type: "github_device_login",
      userCode: "SECRET-CODE",
    });
  });

  it("shows a nonblocking preparing challenge only to the owner", () => {
    const control = new ControlState();
    control.markAuthBlocked(orb.id, owner, "openai-codex");
    control.setChallenge(owner, {
      provider: "openai-codex",
      verificationUri: "",
      userCode: "",
      expiresAt: 1_700_000_000_000,
    });
    expect(orbView({ ...orb, state: "starting" }, control, owner).actionRequired).toMatchObject({
      type: "openai_codex_device_login",
      verificationUri: "",
      userCode: "",
    });
    expect(orbView({ ...orb, state: "starting" }, control, coworker).actionRequired).toEqual({
      type: "owner_login_required",
      provider: "openai-codex",
    });
  });

  it("shows coworkers and ops only an owner-required status", () => {
    const control = new ControlState();
    control.markAuthBlocked(orb.id, owner);
    control.setChallenge(owner, challenge);
    for (const viewerUserId of [coworker, null]) {
      const action = orbView({ ...orb, state: "starting" }, control, viewerUserId).actionRequired;
      expect(action).toEqual({ type: "owner_login_required", provider: "github" });
      expect(JSON.stringify(action)).not.toContain("SECRET-CODE");
      expect(JSON.stringify(action)).not.toContain("github.test");
    }
  });
});

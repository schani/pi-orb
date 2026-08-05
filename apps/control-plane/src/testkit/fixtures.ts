import type { OrbState } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { DEFAULT_LIFECYCLE_CONSTANTS, type LifecycleConstants } from "../domain/constants.ts";
import { ControlState } from "../domain/control-state.ts";
import type { OrbRow, ProjectRow } from "../domain/orb.ts";
import type { ControlPlaneDeps } from "../domain/ports.ts";
import { FakeAuthGate, type FakeAuthMode } from "./auth.ts";
import { InMemoryControlPlaneStore } from "./store.ts";
import { type FakeOrbConfig, FakeOrbHostProvider, FakeRuntimeClient, FakeWorld } from "./world.ts";

/**
 * Faster constants so DST scenarios cover many cycles in little virtual time.
 * The boot-related deadlines are the exception: `FakeWorld` boots hosts with
 * the real ~65s latency, so they keep the production ordering
 * `boot latency < postRestartGraceMs, unreachableBootDeadlineMs <
 * createStartDeadlineMs` instead of being compressed below a boot
 * (docs/testing.md). Both post-boot patience windows sit above a full boot and
 * below the create/start deadline, as they do in production.
 */
export const TEST_CONSTANTS: LifecycleConstants = {
  ...DEFAULT_LIFECYCLE_CONSTANTS,
  readinessPollMs: 1_000,
  unreachableGraceMs: 10_000,
  postRestartGraceMs: 120_000,
  createStartDeadlineMs: 300_000,
  unreachableBootDeadlineMs: 120_000,
  historyPullIntervalMs: 2_000,
  reconcileTickMs: 500,
  retryBackoffBaseMs: 200,
  retryBackoffCapMs: 2_000,
  runtimeRequestTimeoutMs: 3_000,
  providerOperationTimeoutMs: 5_000,
  pullLimit: 5,
  hostBackstopIntervalMs: 2_000,
  idleStopAfterMs: 30_000,
  orphanSweepIntervalMs: 2_000,
};

export interface TestHarness {
  readonly world: FakeWorld;
  readonly store: InMemoryControlPlaneStore;
  readonly authGate: FakeAuthGate;
  readonly deps: ControlPlaneDeps;
}

export function makeHarness(options?: {
  authMode?: FakeAuthMode;
  constants?: Partial<LifecycleConstants>;
}): TestHarness {
  const world = new FakeWorld();
  const store = new InMemoryControlPlaneStore();
  const authGate = new FakeAuthGate(options?.authMode ?? { kind: "always_ok" });
  const deps: ControlPlaneDeps = {
    store,
    hostProvider: new FakeOrbHostProvider(world),
    runtimeClient: new FakeRuntimeClient(world),
    authGate,
    control: new ControlState(),
    constants: { ...TEST_CONSTANTS, ...options?.constants },
  };
  return { world, store, authGate, deps };
}

/** A fresh ControlState + auth flow, same store/world: a control-plane restart. */
export function restartControlPlane(harness: TestHarness): TestHarness {
  harness.authGate.simulateProcessRestart();
  return {
    ...harness,
    deps: { ...harness.deps, control: new ControlState() },
  };
}

export function makeProjectRow(id: string): ProjectRow {
  return {
    id,
    name: `project-${id}`,
    repositoryUrl: "https://github.com/owner/repo",
    createdAt: 0,
  };
}

export function makeOrbRow(
  id: string,
  projectId: string,
  state: OrbState,
  overrides?: Partial<OrbRow>,
): OrbRow {
  return {
    id,
    projectId,
    state,
    stateVersion: 0,
    hostKind: "fake",
    hostRef: null,
    checkoutCommit: null,
    harnessSessionId: null,
    harnessSessionHeader: null,
    lastError: null,
    runtimeTokenHash: null,
    replicationCursor: null,
    replicatedHeadId: null,
    lastBusyAt: null,
    stopReason: null,
    stateChangedAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/**
 * Seed a project plus an orb that is already `running` with a live host and
 * ready runtime — the starting point for pure replication scenarios. The host
 * boot is behind us, so the configured boot latency is fast-forwarded here; it
 * still applies in full to every later restart of this host.
 */
export function seedRunningOrb(
  task: SimulationTask,
  harness: TestHarness,
  orbId: string,
  config?: FakeOrbConfig,
): void {
  const projectId = `project-of-${orbId}`;
  harness.store.seedProject(makeProjectRow(projectId));
  harness.world.configureOrb(orbId, { initDurationMs: 0, ...config });
  const provisioned = harness.world.provisionHost(task, orbId);
  harness.world.finishBoot(task, orbId);
  harness.world.ensureSessionExists(orbId);
  harness.store.seedOrb(
    makeOrbRow(orbId, projectId, "running", {
      hostRef: provisioned.ref.resourceId,
      runtimeTokenHash: provisioned.runtimeTokenHash,
      checkoutCommit: "commit-0",
      stateChangedAt: task.wallNow(),
    }),
  );
  harness.deps.control.resetLivenessBaseline(orbId, task.monotonicNow());
}

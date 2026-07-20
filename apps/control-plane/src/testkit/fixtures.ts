import type { SimulationTask } from "determined";
import type { OrbState } from "@pi-orb/protocol";
import { DEFAULT_LIFECYCLE_CONSTANTS, type LifecycleConstants } from "../domain/constants.ts";
import { ControlState } from "../domain/control-state.ts";
import type { OrbRow, ProjectRow } from "../domain/orb.ts";
import type { ControlPlaneDeps } from "../domain/ports.ts";
import { FakeAuthGate, type FakeAuthMode } from "./auth.ts";
import { InMemoryControlPlaneStore } from "./store.ts";
import { FakeOrbHostProvider, FakeRuntimeClient, FakeWorld, type FakeOrbConfig } from "./world.ts";

/** Faster constants so DST scenarios cover many cycles in little virtual time. */
export const TEST_CONSTANTS: LifecycleConstants = {
  ...DEFAULT_LIFECYCLE_CONSTANTS,
  readinessPollMs: 1_000,
  unreachableGraceMs: 10_000,
  createStartDeadlineMs: 120_000,
  historyPullIntervalMs: 2_000,
  reconcileTickMs: 500,
  retryBackoffBaseMs: 200,
  retryBackoffCapMs: 2_000,
  runtimeRequestTimeoutMs: 3_000,
  providerOperationTimeoutMs: 5_000,
  pullLimit: 5,
  hostBackstopIntervalMs: 2_000,
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
    replicationCursor: null,
    replicatedHeadId: null,
    stateChangedAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/**
 * Seed a project plus an orb that is already `running` with a live host and
 * ready runtime — the starting point for pure replication scenarios.
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
  const ref = harness.world.provisionHost(task, orbId);
  harness.world.ensureSessionExists(orbId);
  harness.store.seedOrb(
    makeOrbRow(orbId, projectId, "running", {
      hostRef: ref.resourceId,
      checkoutCommit: "commit-0",
      stateChangedAt: task.wallNow(),
    }),
  );
  harness.deps.control.resetLivenessBaseline(orbId, task.monotonicNow());
}

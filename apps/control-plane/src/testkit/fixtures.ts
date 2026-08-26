import type { OrbState } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { okAsync } from "neverthrow";
import { DEFAULT_LIFECYCLE_CONSTANTS, type LifecycleConstants } from "../domain/constants.ts";
import { ControlState } from "../domain/control-state.ts";
import type { OrbRow, ProjectRow } from "../domain/orb.ts";
import type { ControlPlaneDeps, OrbNameGenerator } from "../domain/ports.ts";
import { FakeAuthGate, type FakeAuthMode } from "./auth.ts";
import { InMemoryControlPlaneStore } from "./store.ts";
import {
  type FakeOrbConfig,
  FakeOrbHostProvider,
  type FakeProvisionedHost,
  FakeRuntimeClient,
  FakeWorld,
} from "./world.ts";

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
  // Scaled like the production pair: comfortably longer than the create/start
  // deadline it holds off, so a scenario can outlast both.
  setupHookHoldMs: 440_000,
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
  deletionQuarantineMs: 6_000,
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
  const nameGenerator: OrbNameGenerator = {
    generate: (_task, input) => okAsync(`Work on ${input.projectName}`),
  };
  const deps: ControlPlaneDeps = {
    store,
    hostProvider: new FakeOrbHostProvider(world),
    resourceCleaner: { cleanupOrb: () => okAsync(undefined) },
    runtimeClient: new FakeRuntimeClient(world),
    authGate,
    nameGenerator,
    nameLeaseMs: 30_000,
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
    state: "active",
    stateVersion: 0,
    deletionRequestedAt: null,
    deletionInitialOrbCount: null,
    createdAt: 0,
    updatedAt: 0,
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
    name: null,
    autoNameLeaseUntil: null,
    autoNameAttempts: 0,
    autoNameNextAttemptAt: null,
    state,
    stateVersion: 0,
    hostKind: "fake",
    hostRef: null,
    hostIncarnation: 0,
    hostSpecFingerprint: null,
    hostSpecGeneration: null,
    hostDiscardThroughIncarnation: null,
    hostDiscardReason: null,
    hostDiscardError: null,
    hostDiscardEvidence: null,
    hostDiscardRequestedAt: null,
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
 * The specification stamp the harness's own provider would put on this orb's
 * compute. Seeding with anything else (the old `fake-spec-<generation>`
 * default did) makes the seeded host look stale to the start path and turns
 * every scenario into an unintended replacement scenario.
 */
export function desiredSpecFingerprintOf(
  harness: TestHarness,
  orbId: string,
  repositoryUrl: string = makeProjectRow("seed").repositoryUrl,
): string {
  return harness.deps.hostProvider.desiredSpecFingerprint({ orbId, repositoryUrl });
}

/**
 * Provision a host for a seeded orb through the world directly, stamped the
 * way the harness's provider stamps it — or deliberately unstamped
 * (`legacy: true`) to seed the pre-fingerprint cohort of
 * docs/compute-replacement.md rule 1.
 */
export function seedProvisionedHost(
  task: SimulationTask,
  harness: TestHarness,
  orbId: string,
  options?: { repositoryUrl?: string; incarnation?: number; legacy?: boolean },
): FakeProvisionedHost {
  const repositoryUrl = options?.repositoryUrl ?? makeProjectRow("seed").repositoryUrl;
  return harness.world.provisionHost(
    task,
    orbId,
    options?.incarnation ?? 0,
    harness.deps.hostProvider.specGeneration,
    options?.legacy === true ? null : desiredSpecFingerprintOf(harness, orbId, repositoryUrl),
  );
}

/**
 * Seed a project plus an orb that is already `running` with a live host and
 * ready runtime — the starting point for pure replication scenarios. The host
 * boot is behind us, so the configured boot latency is fast-forwarded here; it
 * still applies in full to every later restart of this host.
 *
 * `legacy: true` seeds the pre-Stage-2 cohort instead: an unstamped host under
 * a row with no committed fingerprint or generation, which must keep starting
 * in place until an ordinary stop/start replaces it.
 */
export function seedRunningOrb(
  task: SimulationTask,
  harness: TestHarness,
  orbId: string,
  config?: FakeOrbConfig,
  options?: { legacy?: boolean },
): void {
  const projectId = `project-of-${orbId}`;
  harness.store.seedProject(makeProjectRow(projectId));
  harness.world.configureOrb(orbId, { initDurationMs: 0, ...config });
  const repositoryUrl = makeProjectRow(projectId).repositoryUrl;
  const legacy = options?.legacy === true;
  const provisioned = seedProvisionedHost(task, harness, orbId, {
    repositoryUrl,
    ...(legacy ? { legacy: true } : {}),
  });
  harness.world.finishBoot(task, orbId);
  harness.world.ensureSessionExists(orbId);
  harness.store.seedOrb(
    makeOrbRow(orbId, projectId, "running", {
      hostRef: provisioned.ref.resourceId,
      runtimeTokenHash: provisioned.runtimeTokenHash,
      hostSpecFingerprint: provisioned.specFingerprint,
      hostSpecGeneration: legacy ? null : provisioned.specGeneration,
      checkoutCommit: "commit-0",
      stateChangedAt: task.wallNow(),
    }),
  );
  harness.deps.control.resetLivenessBaseline(orbId, task.monotonicNow());
}

/**
 * Seed a running orb, then atomically fail it with an incarnation-bounded
 * discard fence — the common preamble of every failed-compute disposal
 * scenario (docs/compute-replacement.md).
 */
export async function seedFailedOrbWithDiscardIntent(
  task: SimulationTask,
  harness: TestHarness,
  orbId: string,
  options?: { lastError?: string; evidence?: string },
): Promise<OrbRow> {
  seedRunningOrb(task, harness, orbId);
  const running = harness.store.orbSnapshot(orbId);
  if (running === null) throw new Error(`seeded orb ${orbId} missing`);
  const failed = await harness.store.failOrbAndRequestComputeDiscard(task, {
    orbId,
    expectedStateVersion: running.stateVersion,
    now: task.wallNow(),
    lastError: options?.lastError ?? "runtime_failed: original failure",
    ...(options?.evidence !== undefined ? { evidence: options.evidence } : {}),
  });
  return failed._unsafeUnwrap();
}

/** True once the discard fence cleared and no compute remains for the orb. */
export function discardFinalized(harness: TestHarness, orbId: string): boolean {
  const row = harness.store.orbSnapshot(orbId);
  return (
    row !== null &&
    row.hostDiscardThroughIncarnation === null &&
    harness.world.hostCount(orbId) === 0
  );
}

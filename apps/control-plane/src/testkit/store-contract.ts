import type { HarnessSessionMetadata, HistoryRecord } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { err, ok } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ControlPlaneDatabase } from "../adapters/database.ts";
import type { PostgreSQLClient } from "../adapters/pg/client.ts";
import type { StoreError } from "../domain/errors.ts";
import type { OrbRow, ProjectRow } from "../domain/orb.ts";
import type {
  ControlPlaneStore,
  CredentialPointerStore,
  SigningKeyRow,
  SigningKeyStore,
} from "../domain/ports.ts";

const task = new NoSimulationTask("store contract test", false);
const project: ProjectRow = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "project",
  repositoryUrl: "https://github.com/o/r",
  state: "active",
  stateVersion: 0,
  deletionRequestedAt: null,
  deletionInitialOrbCount: null,
  createdAt: 1_000,
  updatedAt: 1_000,
};
const orb: OrbRow = {
  id: "00000000-0000-4000-8000-000000000002",
  projectId: project.id,
  name: null,
  autoNameLeaseUntil: null,
  autoNameAttempts: 0,
  autoNameNextAttemptAt: null,
  state: "creating",
  stateVersion: 0,
  hostKind: "process",
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
  mintFailureCode: null,
  mintFailureAt: null,
  lastMintAt: null,
  stateChangedAt: 1_000,
  createdAt: 1_000,
  updatedAt: 1_000,
};
const session: HarnessSessionMetadata = { id: "session-1", overflow: {} };
const first: HistoryRecord = {
  id: "record-1",
  parentId: null,
  timestamp: "2026-08-07T00:00:00.000Z",
  type: "message",
  role: "user",
  content: [{ type: "text", text: "hello" }],
  overflow: {},
};
const second: HistoryRecord = {
  id: "record-2",
  parentId: first.id,
  timestamp: "2026-08-07T00:00:01.000Z",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "hi" }],
  overflow: {},
};

/**
 * The store contract, run against every PostgreSQL client. The raw `client` is
 * part of the contract: PGlite and node-postgres bind parameters differently,
 * so the parameter guard has to hold on both (see the parameter-intent note in
 * `adapters/pg/client.ts`).
 */
export interface StoreContractSubject {
  readonly database: ControlPlaneDatabase;
  readonly client: PostgreSQLClient;
}

export interface StoreSemanticsSubject {
  readonly store: ControlPlaneStore;
  close(): Promise<void>;
}

/**
 * The interface-only half of the contract: everything expressible through
 * `ControlPlaneStore` alone. It runs against every PostgreSQL client *and*
 * against `InMemoryControlPlaneStore`, because that in-memory store is the
 * substrate of every DST claim — a divergence there silently invalidates the
 * simulation, not just a test.
 */
export function storeSemanticsContractTests(
  name: string,
  open: () => Promise<StoreSemanticsSubject>,
): void {
  describe(`${name} store contract`, () => {
    let subject: StoreSemanticsSubject;
    let store: ControlPlaneStore;

    beforeEach(async () => {
      subject = await open();
      store = subject.store;
    });

    afterEach(async () => {
      await subject.close();
    });

    async function seed(): Promise<void> {
      expect((await store.insertProject(task, project)).isOk()).toBe(true);
      expect((await store.insertOrb(task, orb)).isOk()).toBe(true);
    }

    it("persists projects and performs lifecycle state-version CAS", async () => {
      await seed();
      expect((await store.getProject(task, project.id))._unsafeUnwrap()).toEqual(project);
      const changed = await store.casTransition(task, {
        orbId: orb.id,
        expectedStateVersion: 0,
        toState: "starting",
        hostRef: "pi-orb-orb-1",
        now: 2_000,
      });
      expect(changed.isOk() && changed.value.state).toBe("starting");
      expect(changed.isOk() && changed.value.stateVersion).toBe(1);

      const stale = await store.casTransition(task, {
        orbId: orb.id,
        expectedStateVersion: 0,
        toState: "failed",
        now: 3_000,
      });
      expect(stale.isErr() && stale.error.type).toBe("state_conflict");
    });

    it("atomically fails, revokes runtime auth, and fences compute disposal", async () => {
      await seed();
      const hosted = await store.casUpdateFields(task, {
        orbId: orb.id,
        expectedStateVersion: 0,
        now: 2_000,
        hostRef: "pi-orb-orb-1-i0",
        runtimeTokenHash: "old-token-hash",
      });
      expect(hosted.isOk()).toBe(true);

      const failed = await store.failOrbAndRequestComputeDiscard(task, {
        orbId: orb.id,
        expectedStateVersion: 1,
        now: 3_000,
        lastError: "runtime_never_answered: no response",
        evidence: "container_status=exited exit_code=42",
      });
      expect(failed.isOk() && failed.value).toMatchObject({
        state: "failed",
        stateVersion: 2,
        hostRef: "pi-orb-orb-1-i0",
        hostIncarnation: 0,
        runtimeTokenHash: null,
        hostDiscardThroughIncarnation: 0,
        hostDiscardReason: "failed",
        hostDiscardError: null,
        hostDiscardEvidence: "container_status=exited exit_code=42",
        hostDiscardRequestedAt: 3_000,
      });

      await store.recordHostDiscardStatus(task, {
        orbId: orb.id,
        throughIncarnation: 0,
        now: 4_000,
        error: "provider temporarily unavailable",
      });
      expect((await store.getOrb(task, orb.id))._unsafeUnwrap()).toMatchObject({
        lastError: "runtime_never_answered: no response",
        hostDiscardError: "provider temporarily unavailable",
      });

      const queued = await store.enqueueOrbMessage(task, {
        orbId: orb.id,
        messageId: "00000000-0000-4000-8000-000000000098",
        content: [{ type: "text", text: "retry this failure" }],
        now: 4_500,
      });
      expect(queued.isOk() && queued.value.message.wakeStateVersion).toBe(2);

      const finalized = await store.finalizeHostDiscard(task, {
        orbId: orb.id,
        expectedStateVersion: 2,
        throughIncarnation: 0,
        now: 5_000,
      });
      expect(finalized.isOk() && finalized.value).toMatchObject({
        state: "failed",
        // Disposal preparation must not retire a wake admitted against this
        // failure. Only the failed -> starting transition consumes its one shot.
        stateVersion: 2,
        hostRef: null,
        hostIncarnation: 1,
        hostDiscardThroughIncarnation: null,
        hostDiscardReason: null,
        hostDiscardError: null,
        hostDiscardEvidence: "container_status=exited exit_code=42",
        hostDiscardRequestedAt: null,
      });

      const woken = await store.casStartOrbForQueuedMessage(task, {
        orbId: orb.id,
        expectedStateVersion: 2,
        now: 6_000,
      });
      expect(woken.isOk() && woken.value).toMatchObject({
        state: "starting",
        stateVersion: 3,
        hostIncarnation: 1,
      });
    });

    it("fences immutable host-spec replacement forward and commits durable intent", async () => {
      await seed();
      const hosted = await store.casUpdateFields(task, {
        orbId: orb.id,
        expectedStateVersion: 0,
        now: 2_000,
        hostRef: "pi-orb-orb-1-i0",
        runtimeTokenHash: "old-token-hash",
        hostSpecFingerprint: "spec-old",
        hostSpecGeneration: 10,
      });
      expect(hosted.isOk()).toBe(true);

      const declined = await store.requestHostSpecReplacement(task, {
        orbId: orb.id,
        expectedStateVersion: 1,
        desiredFingerprint: "spec-stale-revision",
        configuredGeneration: 9,
        now: 3_000,
      });
      expect(declined.isOk() && declined.value).toMatchObject({
        type: "declined",
        committedGeneration: 10,
      });
      expect((await store.getOrb(task, orb.id))._unsafeUnwrap()).toMatchObject({
        hostSpecFingerprint: "spec-old",
        hostSpecGeneration: 10,
        runtimeTokenHash: "old-token-hash",
        hostDiscardThroughIncarnation: null,
      });

      const requested = await store.requestHostSpecReplacement(task, {
        orbId: orb.id,
        expectedStateVersion: 1,
        desiredFingerprint: "spec-new",
        configuredGeneration: 11,
        now: 4_000,
      });
      expect(requested.isOk() && requested.value).toMatchObject({
        type: "requested",
        orb: {
          hostSpecFingerprint: "spec-new",
          hostSpecGeneration: 11,
          runtimeTokenHash: null,
          hostDiscardThroughIncarnation: 0,
          hostDiscardReason: "host_spec_changed",
        },
      });

      const finalized = await store.finalizeHostDiscard(task, {
        orbId: orb.id,
        expectedStateVersion: 1,
        throughIncarnation: 0,
        now: 5_000,
      });
      expect(finalized.isOk() && finalized.value).toMatchObject({
        hostRef: null,
        hostIncarnation: 1,
        hostSpecFingerprint: "spec-new",
        hostSpecGeneration: 11,
        hostDiscardThroughIncarnation: null,
      });
    });

    it("leaves a hostless or same-spec orb untouched and conflicts on a stale version", async () => {
      await seed();
      const seeded = (await store.getOrb(task, orb.id))._unsafeUnwrap();
      // No compute means nothing to replace: the start path provisions the
      // current spec directly (docs/compute-replacement.md).
      const hostless = await store.requestHostSpecReplacement(task, {
        orbId: orb.id,
        expectedStateVersion: 0,
        desiredFingerprint: "spec-a",
        configuredGeneration: 5,
        now: 2_000,
      });
      expect(hostless.isOk() && hostless.value.type).toBe("current");
      expect((await store.getOrb(task, orb.id))._unsafeUnwrap()).toEqual(seeded);

      const hosted = await store.casUpdateFields(task, {
        orbId: orb.id,
        expectedStateVersion: 0,
        now: 3_000,
        hostRef: "pi-orb-orb-1-i0",
        runtimeTokenHash: "live-token-hash",
        hostSpecFingerprint: "spec-a",
        hostSpecGeneration: 5,
      });
      expect(hosted.isOk()).toBe(true);
      const before = (await store.getOrb(task, orb.id))._unsafeUnwrap();

      // The same-spec reuse guarantee is a *store-level* one: an ordinary
      // stop/start of unchanged compute must not write a fence, must not
      // revoke the runtime token, and must not touch the row at all.
      const same = await store.requestHostSpecReplacement(task, {
        orbId: orb.id,
        expectedStateVersion: 1,
        desiredFingerprint: "spec-a",
        configuredGeneration: 6,
        now: 4_000,
      });
      expect(same.isOk() && same.value.type).toBe("current");
      expect((await store.getOrb(task, orb.id))._unsafeUnwrap()).toEqual(before);

      // A request built from a stale read cannot request replacement either.
      const stale = await store.requestHostSpecReplacement(task, {
        orbId: orb.id,
        expectedStateVersion: 0,
        desiredFingerprint: "spec-b",
        configuredGeneration: 6,
        now: 5_000,
      });
      expect(stale.isErr() && stale.error.type).toBe("state_conflict");
      expect((await store.getOrb(task, orb.id))._unsafeUnwrap()).toEqual(before);
    });

    it("requests replacement at the generation boundary and reads a null committed generation as zero", async () => {
      await seed();
      const hosted = await store.casUpdateFields(task, {
        orbId: orb.id,
        expectedStateVersion: 0,
        now: 2_000,
        hostRef: "pi-orb-orb-1-i0",
        runtimeTokenHash: "old-token-hash",
        hostSpecFingerprint: "spec-old",
        hostSpecGeneration: 7,
      });
      expect(hosted.isOk()).toBe(true);
      // The fence is forward-only, not strictly-forward: a revision redeploying
      // its own generation with a changed spec still replaces. A `<` vs `<=`
      // slip in either implementation strands the fleet on the old spec.
      const boundary = await store.requestHostSpecReplacement(task, {
        orbId: orb.id,
        expectedStateVersion: 1,
        desiredFingerprint: "spec-new",
        configuredGeneration: 7,
        now: 3_000,
      });
      expect(boundary.isOk() && boundary.value).toMatchObject({
        type: "requested",
        orb: {
          hostSpecFingerprint: "spec-new",
          hostSpecGeneration: 7,
          runtimeTokenHash: null,
          hostDiscardThroughIncarnation: 0,
          hostDiscardReason: "host_spec_changed",
        },
      });

      // An orb whose compute predates fingerprint stamping has a null
      // committed generation, which reads as 0 — so generation 0 is not
      // "lower" and the first stamped replacement is allowed.
      const unstamped: OrbRow = { ...orb, id: "00000000-0000-4000-8000-00000000000b" };
      expect((await store.insertOrb(task, unstamped)).isOk()).toBe(true);
      expect(
        (
          await store.casUpdateFields(task, {
            orbId: unstamped.id,
            expectedStateVersion: 0,
            now: 4_000,
            hostRef: "pi-orb-orb-2-i0",
          })
        ).isOk(),
      ).toBe(true);
      const legacy = await store.requestHostSpecReplacement(task, {
        orbId: unstamped.id,
        expectedStateVersion: 1,
        desiredFingerprint: "spec-first-stamped",
        configuredGeneration: 0,
        now: 5_000,
      });
      expect(legacy.isOk() && legacy.value).toMatchObject({
        type: "requested",
        orb: {
          hostSpecFingerprint: "spec-first-stamped",
          hostSpecGeneration: 0,
          hostDiscardThroughIncarnation: 0,
          hostDiscardReason: "host_spec_changed",
        },
      });
    });

    it("carries retained failure evidence through a replacement request and finalization", async () => {
      await seed();
      const hosted = await store.casUpdateFields(task, {
        orbId: orb.id,
        expectedStateVersion: 0,
        now: 2_000,
        hostRef: "pi-orb-orb-1-i0",
        runtimeTokenHash: "old-token-hash",
      });
      expect(hosted.isOk()).toBe(true);
      const failed = await store.failOrbAndRequestComputeDiscard(task, {
        orbId: orb.id,
        expectedStateVersion: 1,
        now: 3_000,
        lastError: "runtime_never_answered: no response",
        evidence: "container_status=exited exit_code=42",
      });
      expect(failed.isOk()).toBe(true);
      expect(
        (
          await store.recordHostDiscardStatus(task, {
            orbId: orb.id,
            throughIncarnation: 0,
            now: 3_500,
            error: "provider temporarily unavailable",
          })
        ).isOk(),
      ).toBe(true);

      // A deploy lands while the failed orb still owns its evidence. The
      // request re-aims the intent at the new spec and clears the stale
      // cleanup error, but the evidence is the only forensics left once the
      // host is gone: it survives until a replacement commits.
      const requested = await store.requestHostSpecReplacement(task, {
        orbId: orb.id,
        expectedStateVersion: 2,
        desiredFingerprint: "spec-new",
        configuredGeneration: 3,
        now: 4_000,
      });
      expect(requested.isOk() && requested.value).toMatchObject({
        type: "requested",
        orb: {
          hostSpecFingerprint: "spec-new",
          hostSpecGeneration: 3,
          runtimeTokenHash: null,
          hostDiscardThroughIncarnation: 0,
          hostDiscardReason: "host_spec_changed",
          hostDiscardError: null,
          hostDiscardEvidence: "container_status=exited exit_code=42",
        },
      });

      const finalized = await store.finalizeHostDiscard(task, {
        orbId: orb.id,
        expectedStateVersion: 2,
        throughIncarnation: 0,
        now: 5_000,
      });
      expect(finalized.isOk() && finalized.value).toMatchObject({
        hostRef: null,
        hostIncarnation: 1,
        // Reason `host_spec_changed` carries the desired spec into the
        // replacement; reason `failed` clears it instead.
        hostSpecFingerprint: "spec-new",
        hostSpecGeneration: 3,
        hostDiscardThroughIncarnation: null,
        hostDiscardEvidence: "container_status=exited exit_code=42",
      });

      const committed = await store.casUpdateFields(task, {
        orbId: orb.id,
        expectedStateVersion: 2,
        now: 6_000,
        hostRef: "pi-orb-orb-1-i1",
        runtimeTokenHash: "new-token-hash",
        hostDiscardEvidence: null,
      });
      expect(committed.isOk() && committed.value.hostDiscardEvidence).toBeNull();
    });

    it("forces replacement when provider stamps disagree with durable current spec", async () => {
      await seed();
      const hosted = await store.casUpdateFields(task, {
        orbId: orb.id,
        expectedStateVersion: 0,
        now: 2_000,
        hostRef: "pi-orb-orb-1-i0",
        runtimeTokenHash: "old-token-hash",
        hostSpecFingerprint: "spec-current",
        hostSpecGeneration: 12,
      });
      expect(hosted.isOk()).toBe(true);
      const requested = await store.requestHostSpecReplacement(task, {
        orbId: orb.id,
        expectedStateVersion: 1,
        desiredFingerprint: "spec-current",
        configuredGeneration: 12,
        force: true,
        now: 3_000,
      });
      expect(requested.isOk() && requested.value.type).toBe("requested");
      expect(requested.isOk() && requested.value.orb.hostDiscardReason).toBe("host_spec_changed");

      // Force repairs drift; it is not authority. A draining revision still
      // cannot aim newer-generation compute backwards at its own spec.
      const declined = await store.requestHostSpecReplacement(task, {
        orbId: orb.id,
        expectedStateVersion: 1,
        desiredFingerprint: "spec-stale-revision",
        configuredGeneration: 11,
        force: true,
        now: 4_000,
      });
      expect(declined.isOk() && declined.value).toMatchObject({
        type: "declined",
        committedGeneration: 12,
      });
    });

    it("guards discard finalization and clears retained evidence on replacement commit", async () => {
      await seed();
      const hosted = await store.casUpdateFields(task, {
        orbId: orb.id,
        expectedStateVersion: 0,
        now: 2_000,
        hostRef: "pi-orb-orb-1-i0",
        runtimeTokenHash: "old-token-hash",
        hostSpecFingerprint: "spec-failed",
        hostSpecGeneration: 4,
      });
      expect(hosted.isOk()).toBe(true);
      const failed = await store.failOrbAndRequestComputeDiscard(task, {
        orbId: orb.id,
        expectedStateVersion: 1,
        now: 3_000,
        lastError: "runtime_never_answered: no response",
        evidence: "first evidence",
      });
      expect(failed.isOk()).toBe(true);

      // A finalize naming a fence other than the durable one is a conflict and
      // must change nothing — this WHERE clause is what makes a stale
      // finalize harmless (docs/compute-replacement.md).
      const wrongFence = await store.finalizeHostDiscard(task, {
        orbId: orb.id,
        expectedStateVersion: 2,
        throughIncarnation: 1,
        now: 4_000,
      });
      expect(wrongFence.isErr() && wrongFence.error.type).toBe("state_conflict");
      expect((await store.getOrb(task, orb.id))._unsafeUnwrap()).toMatchObject({
        hostDiscardThroughIncarnation: 0,
        hostIncarnation: 0,
      });

      const finalized = await store.finalizeHostDiscard(task, {
        orbId: orb.id,
        expectedStateVersion: 2,
        throughIncarnation: 0,
        now: 5_000,
      });
      // Reason `failed` carries no desired spec: the replacement recomputes
      // and recommits one, so the disposed incarnation's stamps are cleared.
      expect(finalized.isOk() && finalized.value).toMatchObject({
        hostSpecFingerprint: null,
        hostSpecGeneration: null,
      });

      // A repeated finalize for the already-cleared fence conflicts instead of
      // advancing the incarnation twice.
      const repeated = await store.finalizeHostDiscard(task, {
        orbId: orb.id,
        expectedStateVersion: 2,
        throughIncarnation: 0,
        now: 5_500,
      });
      expect(repeated.isErr() && repeated.error.type).toBe("state_conflict");

      // Status writes naming the cleared fence are silently inert.
      const late = await store.recordHostDiscardStatus(task, {
        orbId: orb.id,
        throughIncarnation: 0,
        now: 6_000,
        error: "late provider error",
      });
      expect(late.isOk()).toBe(true);
      expect((await store.getOrb(task, orb.id))._unsafeUnwrap()).toMatchObject({
        hostDiscardError: null,
        hostDiscardEvidence: "first evidence",
        hostIncarnation: 1,
      });

      // Replacement commit drops the retained evidence so it cannot shadow a
      // later incident; a later failure records fresh evidence.
      const started = await store.casTransition(task, {
        orbId: orb.id,
        expectedStateVersion: 2,
        toState: "starting",
        lastError: null,
        now: 7_000,
      });
      expect(started.isOk()).toBe(true);
      const committed = await store.casUpdateFields(task, {
        orbId: orb.id,
        expectedStateVersion: 3,
        now: 8_000,
        hostRef: "pi-orb-orb-1-i1",
        runtimeTokenHash: "new-token-hash",
        hostDiscardEvidence: null,
      });
      expect(committed.isOk() && committed.value.hostDiscardEvidence).toBeNull();
      const failedAgain = await store.failOrbAndRequestComputeDiscard(task, {
        orbId: orb.id,
        expectedStateVersion: 4,
        now: 9_000,
        lastError: "runtime_failed: second failure",
        evidence: "second evidence",
      });
      expect(failedAgain.isOk() && failedAgain.value).toMatchObject({
        hostDiscardThroughIncarnation: 1,
        hostDiscardError: null,
        hostDiscardEvidence: "second evidence",
      });
    });

    it("records the latest mint failure without disturbing lifecycle state", async () => {
      await seed();
      const running = await store.casTransition(task, {
        orbId: orb.id,
        expectedStateVersion: 0,
        toState: "running",
        now: 2_000,
      });
      expect(running.isOk() && running.value.stateVersion).toBe(1);

      expect(
        (
          await store.recordMintFailure(task, {
            orbId: orb.id,
            code: "not_mintable",
            at: 3_000,
          })
        ).isOk(),
      ).toBe(true);
      // The whole point of the advisory write: identity status is durable, but
      // it must not consume a lifecycle version or restart a state deadline.
      expect((await store.getOrb(task, orb.id))._unsafeUnwrap()).toMatchObject({
        mintFailureCode: "not_mintable",
        mintFailureAt: 3_000,
        stateVersion: 1,
        stateChangedAt: 2_000,
      });

      // The columns move together: the latest failure replaces the previous
      // one whole, never leaving a code without its timestamp.
      expect(
        (
          await store.recordMintFailure(task, {
            orbId: orb.id,
            code: "rate_limited",
            at: 4_000,
          })
        ).isOk(),
      ).toBe(true);
      expect((await store.getOrb(task, orb.id))._unsafeUnwrap()).toMatchObject({
        mintFailureCode: "rate_limited",
        mintFailureAt: 4_000,
      });

      // A bearer that resolves to nothing has no row to write: silently inert,
      // never an error the mint path would have to classify.
      const unknown = await store.recordMintFailure(task, {
        orbId: "00000000-0000-4000-8000-0000000000cc",
        code: "signer_failure",
        at: 5_000,
      });
      expect(unknown.isOk()).toBe(true);
    });

    it("advances the mint rate-limit floor monotonically and only forward", async () => {
      await seed();
      const running = await store.casTransition(task, {
        orbId: orb.id,
        expectedStateVersion: 0,
        toState: "running",
        now: 2_000,
      });
      expect(running.isOk()).toBe(true);

      expect((await store.advanceLastMintAt(task, { orbId: orb.id, at: 5_000 })).isOk()).toBe(true);
      expect((await store.getOrb(task, orb.id))._unsafeUnwrap()).toMatchObject({
        lastMintAt: 5_000,
        stateVersion: 1,
        stateChangedAt: 2_000,
      });

      // Two instances mint concurrently and their writes land out of order:
      // the floor must not move backwards, or the older mint would hand the
      // next caller a free pass through the rate limit.
      expect((await store.advanceLastMintAt(task, { orbId: orb.id, at: 4_000 })).isOk()).toBe(true);
      expect((await store.getOrb(task, orb.id))._unsafeUnwrap()?.lastMintAt).toBe(5_000);

      expect((await store.advanceLastMintAt(task, { orbId: orb.id, at: 6_000 })).isOk()).toBe(true);
      expect((await store.getOrb(task, orb.id))._unsafeUnwrap()?.lastMintAt).toBe(6_000);

      const unknown = await store.advanceLastMintAt(task, {
        orbId: "00000000-0000-4000-8000-0000000000cd",
        at: 7_000,
      });
      expect(unknown.isOk()).toBe(true);
    });

    it("lets mint status writes interleave a lifecycle read and its CAS", async () => {
      await seed();
      const before = (await store.getOrb(task, orb.id))._unsafeUnwrap();
      if (before === null) return;

      // A mint racing a stop is the schedule that matters: both mint writes
      // land between the reconciler's read and its transition, and the
      // transition must still commit against the version it read.
      expect(
        (
          await store.recordMintFailure(task, { orbId: orb.id, code: "rate_limited", at: 2_500 })
        ).isOk(),
      ).toBe(true);
      expect((await store.advanceLastMintAt(task, { orbId: orb.id, at: 2_600 })).isOk()).toBe(true);

      const stopping = await store.casTransition(task, {
        orbId: orb.id,
        expectedStateVersion: before.stateVersion,
        toState: "stopping",
        now: 3_000,
      });
      expect(stopping.isOk() && stopping.value.state).toBe("stopping");
      expect(stopping.isOk() && stopping.value).toMatchObject({
        mintFailureCode: "rate_limited",
        mintFailureAt: 2_500,
        lastMintAt: 2_600,
      });
    });

    it("coordinates auto-naming and preserves a manual name", async () => {
      await seed();
      const claimed = await store.claimOrbAutoName(task, {
        orbId: orb.id,
        now: 2_000,
        leaseUntil: 32_000,
      });
      expect(claimed.isOk() && claimed.value).toBe("claimed");
      const duplicate = await store.claimOrbAutoName(task, {
        orbId: orb.id,
        now: 3_000,
        leaseUntil: 33_000,
      });
      expect(duplicate.isOk() && duplicate.value).toBe("in_progress");
      const manual = await store.setOrbName(task, {
        orbId: orb.id,
        name: "Manual Name",
        now: 4_000,
        onlyIfNull: false,
      });
      expect(manual.isOk() && manual.value?.name).toBe("Manual Name");
      const generated = await store.setOrbName(task, {
        orbId: orb.id,
        name: "Generated Name",
        now: 5_000,
        onlyIfNull: true,
      });
      expect(generated.isOk() && generated.value).toBeNull();
    });

    it("durably queues a stopped-orb message, wakes it, and completes from replicated identity", async () => {
      await seed();
      const stopped = await store.casTransition(task, {
        orbId: orb.id,
        expectedStateVersion: 0,
        toState: "stopped",
        now: 2_000,
      });
      expect(stopped.isOk()).toBe(true);
      const messageId = "00000000-0000-4000-8000-000000000099";
      const content = [{ type: "text" as const, text: "please continue" }];
      const queued = await store.enqueueOrbMessage(task, {
        orbId: orb.id,
        messageId,
        content,
        now: 3_000,
      });
      // Admission records the message and its wake intent; the transition is
      // the reconciler's, through `casStartOrbForQueuedMessage`.
      expect(queued.isOk() && queued.value.orb.state).toBe("stopped");
      expect(queued.isOk() && queued.value.message.status).toBe("queued");
      expect(queued.isOk() && queued.value.message.autoStart).toBe(true);
      expect(queued.isOk() && queued.value.orb.lastBusyAt).toBe(3_000);
      const woken = await store.casStartOrbForQueuedMessage(task, {
        orbId: orb.id,
        expectedStateVersion: 1,
        now: 3_100,
      });
      expect(woken.isOk() && woken.value?.state).toBe("starting");
      const duplicate = await store.enqueueOrbMessage(task, {
        orbId: orb.id,
        messageId,
        content,
        now: 4_000,
      });
      expect(duplicate.isOk() && duplicate.value.duplicate).toBe(true);
      const secondMessageId = "00000000-0000-4000-8000-000000000100";
      expect(
        (
          await store.enqueueOrbMessage(task, {
            orbId: orb.id,
            messageId: secondMessageId,
            content: [{ type: "text", text: "and run tests" }],
            now: 4_500,
          })
        ).isOk(),
      ).toBe(true);
      const batch = await store.claimNextOrbMessageBatch(task, { orbId: orb.id, now: 5_000 });
      expect(batch.isOk() && batch.value.map((message) => message.messageId)).toEqual([
        messageId,
        secondMessageId,
      ]);
      expect(batch.isOk() && batch.value[0]?.deliveryBatchId).toBe(messageId);

      const nativeRecord: HistoryRecord = {
        id: "inbox-record",
        parentId: null,
        timestamp: "2026-08-10T00:00:00.000Z",
        type: "message",
        role: "user",
        content,
        overflow: {
          native: {
            type: "custom_message",
            customType: "pi-orb.user-message",
            details: {
              messageIds: [messageId, secondMessageId],
              delivery: "turn",
              operationId: "op-1",
            },
          },
        },
      };
      const committed = await store.commitPullBatch(task, {
        orbId: orb.id,
        expectedCursor: null,
        session,
        records: [nativeRecord],
        nextCursor: nativeRecord.id,
        nextHeadId: nativeRecord.id,
      });
      expect(committed.isOk()).toBe(true);
      const messages = await store.listOrbMessages(task, orb.id);
      expect(messages.isOk() && messages.value.map((message) => message.status)).toEqual([
        "delivered",
        "delivered",
      ]);
    });

    it("fails a rejected batch terminally and keeps the queue moving", async () => {
      await seed();
      const rejectedId = "00000000-0000-4000-8000-000000000101";
      const followUpId = "00000000-0000-4000-8000-000000000102";
      expect(
        (
          await store.enqueueOrbMessage(task, {
            orbId: orb.id,
            messageId: rejectedId,
            content: [{ type: "text", text: "a payload the runtime refuses" }],
            now: 2_000,
          })
        ).isOk(),
      ).toBe(true);
      const batch = await store.claimNextOrbMessageBatch(task, { orbId: orb.id, now: 2_500 });
      expect(batch.isOk() && batch.value).toHaveLength(1);
      expect(
        (
          await store.failOrbMessageBatch(task, {
            orbId: orb.id,
            messageIds: [rejectedId],
            lastError: "400 invalid_request: message payload too large",
            now: 3_000,
          })
        ).isOk(),
      ).toBe(true);
      const failed = (await store.listOrbMessages(task, orb.id))._unsafeUnwrap()[0];
      expect(failed?.status).toBe("failed");
      expect(failed?.lastError).toContain("invalid_request");
      expect(failed?.autoStart).toBe(false);
      // A failed row leaves the outstanding set: the next message is claimable.
      expect(
        (
          await store.enqueueOrbMessage(task, {
            orbId: orb.id,
            messageId: followUpId,
            content: [{ type: "text", text: "try this instead" }],
            now: 3_500,
          })
        ).isOk(),
      ).toBe(true);
      const next = await store.claimNextOrbMessageBatch(task, { orbId: orb.id, now: 4_000 });
      expect(next.isOk() && next.value.map((message) => message.messageId)).toEqual([followUpId]);
    });

    it("wakes a stopped orb for any outstanding wake intent, not only the oldest message", async () => {
      await seed();
      const running = await store.casTransition(task, {
        orbId: orb.id,
        expectedStateVersion: 0,
        toState: "running",
        now: 2_000,
      });
      expect(running.isOk()).toBe(true);
      const olderId = "00000000-0000-4000-8000-000000000103";
      const wakeId = "00000000-0000-4000-8000-000000000104";
      const older = await store.enqueueOrbMessage(task, {
        orbId: orb.id,
        messageId: olderId,
        content: [{ type: "text", text: "look at the failing test" }],
        now: 2_100,
      });
      expect(older.isOk() && older.value.message.autoStart).toBe(false);
      const stopping = await store.casTransition(task, {
        orbId: orb.id,
        expectedStateVersion: 1,
        toState: "stopping",
        now: 2_200,
      });
      expect(stopping.isOk()).toBe(true);
      const wake = await store.enqueueOrbMessage(task, {
        orbId: orb.id,
        messageId: wakeId,
        content: [{ type: "text", text: "and then open a PR" }],
        now: 2_300,
      });
      expect(wake.isOk() && wake.value.message.autoStart).toBe(true);
      const stopped = await store.casTransition(task, {
        orbId: orb.id,
        expectedStateVersion: 2,
        toState: "stopped",
        now: 2_400,
      });
      expect(stopped.isOk() && stopped.value.stateVersion).toBe(3);

      const woken = await store.casStartOrbForQueuedMessage(task, {
        orbId: orb.id,
        expectedStateVersion: 3,
        now: 2_500,
      });
      expect(woken.isOk() && woken.value?.state).toBe("starting");
      // The intent stands until the message is delivered, failed, or an
      // explicit stop clears it: the wake has no second write to strand.
      const afterWake = (await store.listOrbMessages(task, orb.id))._unsafeUnwrap();
      expect(afterWake.map((message) => message.autoStart)).toEqual([false, true]);

      const backToStopped = await store.casTransition(task, {
        orbId: orb.id,
        expectedStateVersion: 4,
        toState: "stopped",
        now: 2_600,
      });
      expect(backToStopped.isOk()).toBe(true);
      expect(
        (await store.clearOrbMessageAutoStart(task, { orbId: orb.id, now: 2_700 })).isOk(),
      ).toBe(true);
      const notWoken = await store.casStartOrbForQueuedMessage(task, {
        orbId: orb.id,
        expectedStateVersion: 5,
        now: 2_800,
      });
      expect(notWoken.isOk() && notWoken.value).toBeNull();
      expect((await store.getOrb(task, orb.id))._unsafeUnwrap()?.state).toBe("stopped");
    });

    it("wakes a failed orb once for a new send and never for a stranded intent", async () => {
      await seed();
      const failed = await store.casTransition(task, {
        orbId: orb.id,
        expectedStateVersion: 0,
        toState: "failed",
        now: 2_000,
        lastError: "provider_failed: boom",
      });
      expect(failed.isOk() && failed.value.stateVersion).toBe(1);
      const messageId = "00000000-0000-4000-8000-000000000106";
      const queued = await store.enqueueOrbMessage(task, {
        orbId: orb.id,
        messageId,
        content: [{ type: "text", text: "try again please" }],
        now: 2_100,
      });
      // A send made against *this* failure carries the version it saw.
      expect(queued.isOk() && queued.value.message.autoStart).toBe(true);
      expect(queued.isOk() && queued.value.message.wakeStateVersion).toBe(1);
      const woken = await store.casStartOrbForQueuedMessage(task, {
        orbId: orb.id,
        expectedStateVersion: 1,
        now: 2_200,
      });
      expect(woken.isOk() && woken.value?.state).toBe("starting");
      expect(woken.isOk() && woken.value?.lastError).toBeNull();

      // The boot fails again. The same intent is now stranded: it names a
      // failure two versions old, so it must not provision forever.
      const failedAgain = await store.casTransition(task, {
        orbId: orb.id,
        expectedStateVersion: 2,
        toState: "failed",
        now: 2_300,
        lastError: "provider_failed: boom again",
      });
      expect(failedAgain.isOk() && failedAgain.value.stateVersion).toBe(3);
      const notWoken = await store.casStartOrbForQueuedMessage(task, {
        orbId: orb.id,
        expectedStateVersion: 3,
        now: 2_400,
      });
      expect(notWoken.isOk() && notWoken.value).toBeNull();
      expect((await store.getOrb(task, orb.id))._unsafeUnwrap()?.state).toBe("failed");

      // A new send against the new failure buys exactly one more attempt.
      const retried = await store.enqueueOrbMessage(task, {
        orbId: orb.id,
        messageId: "00000000-0000-4000-8000-000000000107",
        content: [{ type: "text", text: "once more" }],
        now: 2_500,
      });
      expect(retried.isOk() && retried.value.message.wakeStateVersion).toBe(3);
      const wokenAgain = await store.casStartOrbForQueuedMessage(task, {
        orbId: orb.id,
        expectedStateVersion: 3,
        now: 2_600,
      });
      expect(wokenAgain.isOk() && wokenAgain.value?.state).toBe("starting");
    });

    it("records a delivery note that replication already marked delivered", async () => {
      await seed();
      const messageId = "00000000-0000-4000-8000-000000000105";
      const content = [{ type: "text" as const, text: "how was this delivered?" }];
      expect(
        (
          await store.enqueueOrbMessage(task, { orbId: orb.id, messageId, content, now: 2_000 })
        ).isOk(),
      ).toBe(true);
      expect(
        (await store.claimNextOrbMessageBatch(task, { orbId: orb.id, now: 2_100 })).isOk(),
      ).toBe(true);
      const record: HistoryRecord = {
        id: "inbox-record-late-note",
        parentId: null,
        timestamp: "2026-08-10T00:00:00.000Z",
        type: "message",
        role: "user",
        content,
        overflow: {
          native: {
            type: "custom_message",
            customType: "pi-orb.user-message",
            details: { messageIds: [messageId] },
          },
        },
      };
      expect(
        (
          await store.commitPullBatch(task, {
            orbId: orb.id,
            expectedCursor: null,
            session,
            records: [record],
            nextCursor: record.id,
            nextHeadId: record.id,
          })
        ).isOk(),
      ).toBe(true);
      expect((await store.listOrbMessages(task, orb.id))._unsafeUnwrap()[0]?.status).toBe(
        "delivered",
      );
      // The note lands last and must still record how the message was
      // admitted, without undoing the delivered status.
      expect(
        (
          await store.noteOrbMessageDelivery(task, {
            orbId: orb.id,
            messageIds: [messageId],
            delivery: "steer",
            operationId: "op-late",
            now: 2_500,
          })
        ).isOk(),
      ).toBe(true);
      const noted = (await store.listOrbMessages(task, orb.id))._unsafeUnwrap()[0];
      expect(noted?.status).toBe("delivered");
      expect(noted?.delivery).toBe("steer");
      expect(noted?.operationId).toBe("op-late");
    });

    it("atomically commits idempotent history and reconstructs its linear chain", async () => {
      await seed();
      const committed = await store.commitPullBatch(task, {
        orbId: orb.id,
        expectedCursor: null,
        session,
        records: [first, second],
        nextCursor: second.id,
        nextHeadId: second.id,
      });
      expect(committed.isOk() && committed.value.replicationCursor).toBe(second.id);

      const repeated = await store.commitPullBatch(task, {
        orbId: orb.id,
        expectedCursor: second.id,
        session,
        records: [first, second],
        nextCursor: second.id,
        nextHeadId: second.id,
      });
      expect(repeated.isOk()).toBe(true);

      const snapshot = await store.readHistorySnapshot(task, orb.id);
      expect(snapshot.isOk() && snapshot.value.records).toEqual([first, second]);
    });

    it("rejects cursor and immutable-record conflicts without partial advancement", async () => {
      await seed();
      expect(
        (
          await store.commitPullBatch(task, {
            orbId: orb.id,
            expectedCursor: null,
            session,
            records: [first],
            nextCursor: first.id,
            nextHeadId: first.id,
          })
        ).isOk(),
      ).toBe(true);

      const cursorConflict = await store.commitPullBatch(task, {
        orbId: orb.id,
        expectedCursor: null,
        session,
        records: [second],
        nextCursor: second.id,
        nextHeadId: second.id,
      });
      expect(cursorConflict.isErr() && cursorConflict.error.type).toBe("cursor_conflict");

      const changed = { ...first, content: [{ type: "text" as const, text: "changed" }] };
      const recordConflict = await store.commitPullBatch(task, {
        orbId: orb.id,
        expectedCursor: first.id,
        session,
        records: [changed],
        nextCursor: first.id,
        nextHeadId: first.id,
      });
      expect(recordConflict.isErr() && recordConflict.error.type).toBe("replication_integrity");
      const snapshot = await store.readHistorySnapshot(task, orb.id);
      expect(snapshot.isOk() && snapshot.value.cursor).toBe(first.id);
    });

    it("atomically fences project creation, fans out deletion, and finalizes last", async () => {
      await seed();
      const requested = await store.requestProjectDeletion(task, {
        projectId: project.id,
        now: 2_000,
        cleanupAfter: 3_000,
      });
      expect(requested.isOk() && requested.value.newlyRequested).toBe(true);
      expect(requested.isOk() && requested.value.orbs[0]?.state).toBe("deleting");
      expect((await store.getOrbDeletion(task, orb.id))._unsafeUnwrap()?.kind).toBe("delete");

      const lateOrb = { ...orb, id: "00000000-0000-4000-8000-000000000003" };
      const lateInsert = await store.insertOrb(task, lateOrb);
      expect(lateInsert.isErr() && lateInsert.error.type).toBe("project_conflict");
      const progress = await store.getProjectDeletionProgress(task, project.id);
      expect(progress._unsafeUnwrap()).toEqual({ total: 1, remaining: 1, blocked: 0 });
      expect(
        (
          await store.recordOrbDeletionError(task, {
            orbId: orb.id,
            message: "provider unavailable",
            now: 2_500,
          })
        ).isOk(),
      ).toBe(true);
      expect(
        (
          await store.requestProjectDeletion(task, {
            projectId: project.id,
            now: 2_600,
            cleanupAfter: 3_600,
          })
        ).isOk(),
      ).toBe(true);
      expect(
        (await store.getProjectDeletionProgress(task, project.id))._unsafeUnwrap().blocked,
      ).toBe(1);
      const earlyFinalize = await store.finalizeProjectDeletion(task, {
        projectId: project.id,
        expectedStateVersion: requested._unsafeUnwrap().project.stateVersion,
      });
      expect(earlyFinalize.isErr() && earlyFinalize.error.type).toBe("project_conflict");

      const deletingOrb = requested._unsafeUnwrap().orbs[0];
      if (deletingOrb === undefined) return;
      expect(
        (
          await store.finalizeOrbDeletion(task, {
            orbId: orb.id,
            expectedStateVersion: deletingOrb.stateVersion,
          })
        ).isOk(),
      ).toBe(true);
      expect(
        (
          await store.finalizeProjectDeletion(task, {
            projectId: project.id,
            expectedStateVersion: requested._unsafeUnwrap().project.stateVersion,
          })
        ).isOk(),
      ).toBe(true);
      expect((await store.getProject(task, project.id))._unsafeUnwrap()).toBeNull();
    });

    it("upgrades an in-progress archive when its project is deleted", async () => {
      await seed();
      const archived = await store.requestOrbArchive(task, {
        orbId: orb.id,
        expectedStateVersion: 0,
        now: 2_000,
        cleanupAfter: 3_000,
      });
      expect(archived.isOk()).toBe(true);
      const projectDelete = await store.requestProjectDeletion(task, {
        projectId: project.id,
        now: 2_500,
        cleanupAfter: 3_500,
      });
      expect(projectDelete.isOk() && projectDelete.value.orbs[0]?.state).toBe("deleting");
      const intent = await store.getOrbDeletion(task, orb.id);
      expect(intent.isOk() && intent.value?.kind).toBe("delete");
      expect(intent.isOk() && intent.value?.historySealedAt).toBeNull();
    });

    it("atomically requests and finalizes permanent deletion with history", async () => {
      await seed();
      expect(
        (
          await store.commitPullBatch(task, {
            orbId: orb.id,
            expectedCursor: null,
            session,
            records: [first, second],
            nextCursor: second.id,
            nextHeadId: second.id,
          })
        ).isOk(),
      ).toBe(true);
      const requested = await store.requestOrbDeletion(task, {
        orbId: orb.id,
        expectedStateVersion: 0,
        now: 2_000,
        cleanupAfter: 3_000,
      });
      expect(requested.isOk() && requested.value.state).toBe("deleting");
      expect((await store.getOrbDeletion(task, orb.id)).isOk()).toBe(true);
      if (requested.isErr()) return;
      expect(
        (
          await store.finalizeOrbDeletion(task, {
            orbId: orb.id,
            expectedStateVersion: requested.value.stateVersion,
          })
        ).isOk(),
      ).toBe(true);
      expect((await store.getOrb(task, orb.id))._unsafeUnwrap()).toBeNull();
      expect((await store.getOrbDeletion(task, orb.id))._unsafeUnwrap()).toBeNull();
      expect((await store.readHistorySnapshot(task, orb.id))._unsafeUnwrap().records).toEqual([]);
    });

    it("seals and finalizes archival without deleting history", async () => {
      await seed();
      expect(
        (
          await store.commitPullBatch(task, {
            orbId: orb.id,
            expectedCursor: null,
            session,
            records: [first, second],
            nextCursor: second.id,
            nextHeadId: second.id,
          })
        ).isOk(),
      ).toBe(true);
      const requested = await store.requestOrbArchive(task, {
        orbId: orb.id,
        expectedStateVersion: 0,
        now: 2_000,
        cleanupAfter: 3_000,
      });
      expect(requested.isOk() && requested.value.state).toBe("archiving");
      if (requested.isErr()) return;
      expect(
        (
          await store.sealOrbArchive(task, {
            orbId: orb.id,
            expectedStateVersion: requested.value.stateVersion,
            now: 2_500,
            cursor: second.id,
            headId: second.id,
          })
        ).isOk(),
      ).toBe(true);
      const finalized = await store.finalizeOrbArchive(task, {
        orbId: orb.id,
        expectedStateVersion: requested.value.stateVersion,
        now: 4_000,
      });
      expect(finalized.isOk() && finalized.value.state).toBe("archived");
      expect(finalized.isOk() && finalized.value.hostRef).toBeNull();
      expect((await store.getOrbDeletion(task, orb.id))._unsafeUnwrap()).toBeNull();
      expect((await store.readHistorySnapshot(task, orb.id))._unsafeUnwrap().records).toEqual([
        first,
        second,
      ]);
    });
  });
}

export interface SigningKeyStoreSubject {
  readonly keys: SigningKeyStore;
  close(): Promise<void>;
}

const jwk = (n: string): unknown => ({ kty: "RSA", alg: "RS256", use: "sig", e: "AQAB", n });

/**
 * The signing-key contract (docs/workload-identity.md), run against the SQL
 * adapter and the in-memory fake alike: the fake is what the deterministic
 * issuer tests reason about, so a divergence there invalidates the simulation
 * rather than merely a test.
 */
export function signingKeyStoreContractTests(
  name: string,
  open: () => Promise<SigningKeyStoreSubject>,
): void {
  describe(`${name} signing key store contract`, () => {
    let subject: SigningKeyStoreSubject;
    let keys: SigningKeyStore;

    beforeEach(async () => {
      subject = await open();
      keys = subject.keys;
    });

    afterEach(async () => {
      await subject.close();
    });

    const pending = (kid: string, createdAt: number): SigningKeyRow => ({
      kid,
      secretVersion: `secret/${kid}`,
      publicJwk: jwk(`modulus-${kid}`),
      state: "pending",
      createdAt,
      activatedAt: null,
      retiredAt: null,
      rowVersion: 0,
    });

    it("inserts keys with their JWK intact and lists them oldest first", async () => {
      expect((await keys.insertSigningKey(task, pending("kid-b", 2_000))).isOk()).toBe(true);
      expect((await keys.insertSigningKey(task, pending("kid-a", 1_000))).isOk()).toBe(true);
      const listed = await keys.listSigningKeys(task);
      expect(listed.isOk() && listed.value.map((key) => key.kid)).toEqual(["kid-a", "kid-b"]);
      expect(listed.isOk() && listed.value[0]).toEqual(pending("kid-a", 1_000));
    });

    it("refuses a duplicate kid and a second active key as corruption", async () => {
      expect((await keys.insertSigningKey(task, pending("kid-a", 1_000))).isOk()).toBe(true);
      const duplicate = await keys.insertSigningKey(task, pending("kid-a", 2_000));
      expect(duplicate.isErr() && duplicate.error.type).toBe("store_error");
      expect(duplicate.isErr() && duplicate.error.code).toBe("corruption");

      const activated = await keys.casSigningKeyState(task, {
        kid: "kid-a",
        expectedRowVersion: 0,
        state: "active",
        activatedAt: 3_000,
      });
      expect(activated.isOk()).toBe(true);
      // Exactly one key signs: an insert that would create a second active key
      // is a schema violation, not a conflict a caller could retry into.
      const second = await keys.insertSigningKey(task, {
        ...pending("kid-b", 4_000),
        state: "active",
        activatedAt: 4_000,
      });
      expect(second.isErr() && second.error.type).toBe("store_error");
      expect(second.isErr() && second.error.code).toBe("corruption");
      const listed = await keys.listSigningKeys(task);
      expect(listed.isOk() && listed.value.map((key) => key.kid)).toEqual(["kid-a"]);
    });

    it("fences activation and retirement on the row version", async () => {
      expect((await keys.insertSigningKey(task, pending("kid-a", 1_000))).isOk()).toBe(true);
      const activated = await keys.casSigningKeyState(task, {
        kid: "kid-a",
        expectedRowVersion: 0,
        state: "active",
        activatedAt: 2_000,
      });
      expect(activated.isOk() && activated.value).toMatchObject({
        state: "active",
        activatedAt: 2_000,
        retiredAt: null,
        rowVersion: 1,
      });

      // Retirement keeps the activation timestamp: the overlap window is
      // reconstructable from the row after the fact.
      const retired = await keys.casSigningKeyState(task, {
        kid: "kid-a",
        expectedRowVersion: 1,
        state: "retired",
        retiredAt: 5_000,
      });
      expect(retired.isOk() && retired.value).toMatchObject({
        state: "retired",
        activatedAt: 2_000,
        retiredAt: 5_000,
        rowVersion: 2,
      });
    });

    it("refuses to activate a second key while one is already active", async () => {
      expect((await keys.insertSigningKey(task, pending("kid-a", 1_000))).isOk()).toBe(true);
      expect((await keys.insertSigningKey(task, pending("kid-b", 2_000))).isOk()).toBe(true);
      expect(
        (
          await keys.casSigningKeyState(task, {
            kid: "kid-a",
            expectedRowVersion: 0,
            state: "active",
            activatedAt: 3_000,
          })
        ).isOk(),
      ).toBe(true);

      // Rotation activates the new key only after retiring the old one, so an
      // activation that would double the signing key is a schema violation,
      // not a race the caller retries.
      const second = await keys.casSigningKeyState(task, {
        kid: "kid-b",
        expectedRowVersion: 0,
        state: "active",
        activatedAt: 4_000,
      });
      expect(second.isErr() && second.error.type).toBe("store_error");
      expect(second.isErr() && second.error.type === "store_error" && second.error.code).toBe(
        "corruption",
      );
      const listed = await keys.listSigningKeys(task);
      expect(listed.isOk() && listed.value.map((key) => key.state)).toEqual(["active", "pending"]);
    });

    it("conflicts on a stale row version and on an unknown kid without writing", async () => {
      expect((await keys.insertSigningKey(task, pending("kid-a", 1_000))).isOk()).toBe(true);
      expect(
        (
          await keys.casSigningKeyState(task, {
            kid: "kid-a",
            expectedRowVersion: 0,
            state: "active",
            activatedAt: 2_000,
          })
        ).isOk(),
      ).toBe(true);

      // Two operators rotate at once from the same read; the loser must not
      // retire the key the winner just activated.
      const stale = await keys.casSigningKeyState(task, {
        kid: "kid-a",
        expectedRowVersion: 0,
        state: "retired",
        retiredAt: 3_000,
      });
      expect(stale.isErr() && stale.error.type).toBe("signing_key_conflict");

      const missing = await keys.casSigningKeyState(task, {
        kid: "kid-missing",
        expectedRowVersion: 0,
        state: "active",
        activatedAt: 3_000,
      });
      expect(missing.isErr() && missing.error.type).toBe("signing_key_conflict");

      const listed = await keys.listSigningKeys(task);
      expect(listed.isOk() && listed.value).toHaveLength(1);
      expect(listed.isOk() && listed.value[0]).toMatchObject({
        state: "active",
        retiredAt: null,
        rowVersion: 1,
      });
    });
  });
}

/**
 * The full contract for a PostgreSQL-backed store: the shared semantics above
 * plus the driver-level expectations that need the raw client and the
 * credential pointer store.
 */
export function storeContractTests(name: string, open: () => Promise<StoreContractSubject>): void {
  storeSemanticsContractTests(name, async () => {
    const subject = await open();
    const migrated = await subject.database.migrate();
    expect(migrated.isOk()).toBe(true);
    return {
      store: subject.database.store,
      close: async () => {
        expect((await subject.database.close()).isOk()).toBe(true);
      },
    };
  });

  signingKeyStoreContractTests(name, async () => {
    const subject = await open();
    const migrated = await subject.database.migrate();
    expect(migrated.isOk()).toBe(true);
    return {
      keys: subject.database.signingKeys,
      close: async () => {
        expect((await subject.database.close()).isOk()).toBe(true);
      },
    };
  });

  describe(`${name} driver contract`, () => {
    let database: ControlPlaneDatabase;
    let client: PostgreSQLClient;
    let store: ControlPlaneStore;
    let pointers: CredentialPointerStore;

    beforeEach(async () => {
      const subject = await open();
      database = subject.database;
      client = subject.client;
      const migrated = await database.migrate();
      expect(migrated.isOk()).toBe(true);
      store = database.store;
      pointers = database.pointers;
    });

    afterEach(async () => {
      expect((await database.close()).isOk()).toBe(true);
    });

    async function seed(): Promise<void> {
      expect((await store.insertProject(task, project)).isOk()).toBe(true);
      expect((await store.insertOrb(task, orb)).isOk()).toBe(true);
    }

    // The regression from
    // docs/postmortems/2026-08-11-orb-message-jsonb-param-encoding.md: the
    // message content array must survive the round trip through the `jsonb`
    // column on *this* driver, and any structured parameter that forgot to
    // declare its intent must fail as an `invariant` before the driver sees it.
    it("round-trips structured jsonb parameters and refuses undeclared ones", async () => {
      await seed();
      const messageId = "00000000-0000-4000-8000-0000000000aa";
      const content = [
        { type: "text" as const, text: 'first block, with "quotes" and ünïcode' },
        { type: "text" as const, text: "second block" },
      ];
      const queued = await store.enqueueOrbMessage(task, {
        orbId: orb.id,
        messageId,
        content,
        now: 2_000,
      });
      expect(queued.isOk()).toBe(true);
      expect(queued.isOk() && queued.value.message.content).toEqual(content);
      const listed = await store.listOrbMessages(task, orb.id);
      expect(listed.isOk() && listed.value[0]?.content).toEqual(content);
      // The duplicate check compares the stored value against the raw JS one.
      const duplicate = await store.enqueueOrbMessage(task, {
        orbId: orb.id,
        messageId,
        content,
        now: 2_500,
      });
      expect(duplicate.isOk() && duplicate.value.duplicate).toBe(true);
      // A stored session header is an object-shaped jsonb parameter.
      expect(
        (
          await store.initOrVerifySession(task, orb.id, {
            id: "session-jsonb",
            overflow: { nested: { list: [1, 2, 3] } },
          })
        ).isOk(),
      ).toBe(true);
      expect((await store.getOrb(task, orb.id))._unsafeUnwrap()?.harnessSessionHeader).toEqual({
        id: "session-jsonb",
        overflow: { nested: { list: [1, 2, 3] } },
      });

      const bareArray = await client.query("SELECT $1::jsonb AS value", [[{ type: "text" }]]);
      expect(bareArray.isErr() && bareArray.error.code).toBe("invariant");
      expect(bareArray.isErr() && bareArray.error.retryable).toBe(false);
      expect(bareArray.isErr() && bareArray.error.message).toContain("$1");
      const bareObject = await client.query("SELECT $1::text, $2::jsonb AS value", [
        "x",
        { type: "text" },
      ]);
      expect(bareObject.isErr() && bareObject.error.code).toBe("invariant");
      expect(bareObject.isErr() && bareObject.error.message).toContain("$2");
      // The guard also holds inside a transaction-scoped query.
      const inTransaction = await client.transaction<void, StoreError>(async (query) => {
        const guarded = await query("SELECT $1::jsonb AS value", [[1, 2]]);
        return guarded.isErr() ? err(guarded.error) : ok(undefined);
      });
      expect(inTransaction.isErr() && inTransaction.error.code).toBe("invariant");
      // A genuine SQL/schema mistake classifies the same way.
      const missingColumn = await client.query("SELECT no_such_column FROM orbs");
      expect(missingColumn.isErr() && missingColumn.error.code).toBe("invariant");
    });

    it("implements credential pointer CAS", async () => {
      const inserted = await pointers.casWritePointer(task, "openai-codex", null, {
        generation: 1,
        secretVersion: "v1",
        refreshLeaseUntil: 10,
        lastRefreshAt: 5,
      });
      expect(inserted.isOk() && inserted.value.rowVersion).toBe(1);

      const conflict = await pointers.casWritePointer(task, "openai-codex", null, {
        generation: 2,
        secretVersion: "v2",
        refreshLeaseUntil: 20,
        lastRefreshAt: 15,
      });
      expect(conflict.isErr() && conflict.error.type).toBe("pointer_conflict");
    });
  });
}

import type { HarnessSessionMetadata, HistoryRecord } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { err, ok } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ControlPlaneDatabase } from "../adapters/database.ts";
import type { PostgreSQLClient } from "../adapters/pg/client.ts";
import type { StoreError } from "../domain/errors.ts";
import type { OrbRow, ProjectRow } from "../domain/orb.ts";
import type { ControlPlaneStore, CredentialPointerStore } from "../domain/ports.ts";

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

export function storeContractTests(name: string, open: () => Promise<StoreContractSubject>): void {
  describe(`${name} store contract`, () => {
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
    });

    it("guards discard finalization and clears retained evidence on replacement commit", async () => {
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
      expect(finalized.isOk()).toBe(true);

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

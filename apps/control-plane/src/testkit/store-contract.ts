import type { HarnessSessionMetadata, HistoryRecord } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ControlPlaneDatabase } from "../adapters/database.ts";
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

export function storeContractTests(name: string, open: () => Promise<ControlPlaneDatabase>): void {
  describe(`${name} store contract`, () => {
    let database: ControlPlaneDatabase;
    let store: ControlPlaneStore;
    let pointers: CredentialPointerStore;

    beforeEach(async () => {
      database = await open();
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

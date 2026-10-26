import assert from "node:assert/strict";
import {
  type HarnessSessionMetadata,
  type HistoryRecord,
  OWNER_SKILL_MAX_COUNT,
} from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { err, ok, type ResultAsync } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ControlPlaneDatabase } from "../adapters/database.ts";
import { jsonParam, type PostgreSQLClient } from "../adapters/pg/client.ts";
import { PostgreSQLOwnerSkillStore } from "../adapters/pg/owner-skills.ts";
import type { StoreError } from "../domain/errors.ts";
import { messageBatchId } from "../domain/message-batch.ts";
import type { OrbRow, ProjectRow } from "../domain/orb.ts";
import type { OwnerSkillStore } from "../domain/owner-skills.ts";
import type {
  CentralAgentCaller,
  ControlPlaneStore,
  CredentialPointerStore,
  ProjectSecretPointerStore,
  SigningKeyRow,
  SigningKeyStore,
} from "../domain/ports.ts";

const task = new NoSimulationTask("store contract test", false);
const OWNER = "00000000-0000-4000-8000-000000000099";
const project: ProjectRow = {
  id: "00000000-0000-4000-8000-000000000001",
  ownerUserId: OWNER,
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
  harness: "pi",
  initialModel: null,
  name: null,
  userTimeZone: null,
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
  resourceWarnings: [],
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
  stopReason: null,
  agentAdmissionVersion: 0,
  sleepId: null,
  sleepUntil: null,
  lastMintAt: null,
  autoRestartTimes: [],
  stateChangedAt: 1_000,
  createdAt: 1_000,
  updatedAt: 1_000,
};
const unicodeStrings = ["\u0000", "\ud800", "\udfff", "\\u0000", "😀"];
const unicodeOverflow = Object.fromEntries(unicodeStrings.map((text) => [text, { [text]: text }]));

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

    async function seedHeadline() {
      await seed();
      (
        await store.commitPullBatch(task, {
          orbId: orb.id,
          expectedCursor: null,
          session,
          records: [first, second],
          nextCursor: second.id,
          nextHeadId: second.id,
        })
      )._unsafeUnwrap();
      return {
        orbId: orb.id,
        sessionId: session.id,
        recordId: first.id,
        detailKey: "record-1:0",
        headline: "Inspect configuration",
        generatedAt: 1234,
      };
    }

    it("caches activity headlines separately with isolated keys and unchanged history", async () => {
      const value = await seedHeadline();
      const before = (await store.readHistorySnapshot(task, orb.id))._unsafeUnwrap();
      expect((await store.readActivityHeadline(task, value))._unsafeUnwrap()).toBeNull();
      expect((await store.readActivityHeadlines(task, orb.id, session.id))._unsafeUnwrap()).toEqual(
        [],
      );
      expect((await store.putActivityHeadlineIfAbsent(task, value))._unsafeUnwrap()).toEqual(value);
      const other = { ...value, detailKey: "record-1:1", headline: "Other detail" };
      const record = { ...value, recordId: second.id, headline: "Other record" };
      const otherOrbId = "00000000-0000-4000-8000-000000000003";
      (await store.insertOrb(task, { ...orb, id: otherOrbId }))._unsafeUnwrap();
      (
        await store.commitPullBatch(task, {
          orbId: otherOrbId,
          expectedCursor: null,
          session,
          records: [first],
          nextCursor: first.id,
          nextHeadId: first.id,
        })
      )._unsafeUnwrap();
      const otherOrb = { ...value, orbId: otherOrbId, headline: "Other orb" };
      expect((await store.putActivityHeadlineIfAbsent(task, otherOrb))._unsafeUnwrap()).toEqual(
        otherOrb,
      );
      expect((await store.readActivityHeadline(task, otherOrb))._unsafeUnwrap()).toEqual(otherOrb);
      for (const candidate of [other, record])
        expect((await store.putActivityHeadlineIfAbsent(task, candidate))._unsafeUnwrap()).toEqual(
          candidate,
        );
      expect((await store.readActivityHeadline(task, value))._unsafeUnwrap()).toEqual(value);
      expect((await store.readActivityHeadlines(task, orb.id, session.id))._unsafeUnwrap()).toEqual(
        expect.arrayContaining([value, other, record]),
      );
      expect(
        (await store.readActivityHeadlines(task, orb.id, "other-session"))._unsafeUnwrap(),
      ).toEqual([]);
      expect(
        (await store.readActivityHeadlines(task, project.id, session.id))._unsafeUnwrap(),
      ).toEqual([]);
      expect((await store.readHistorySnapshot(task, orb.id))._unsafeUnwrap()).toEqual(before);
    });

    it("returns the first successful headline and its timestamp to both concurrent writers", async () => {
      const value = await seedHeadline();
      const candidate = { ...value, headline: "Competing headline", generatedAt: 9876 };
      const [firstOutcome, secondOutcome] = await Promise.all([
        store.putActivityHeadlineIfAbsent(task, value),
        store.putActivityHeadlineIfAbsent(task, candidate),
      ]);
      const winner = firstOutcome._unsafeUnwrap();
      expect([value, candidate]).toContainEqual(winner);
      expect(secondOutcome._unsafeUnwrap()).toEqual(winner);
      expect((await store.readActivityHeadline(task, value))._unsafeUnwrap()).toEqual(winner);
    });

    it("fences missing sources, stale sessions and deletion even on existing cache keys", async () => {
      const value = await seedHeadline();
      for (const invalid of [
        { ...value, sessionId: "stale" },
        { ...value, recordId: "missing" },
        { ...value, orbId: project.id },
      ])
        expect((await store.putActivityHeadlineIfAbsent(task, invalid))._unsafeUnwrap()).toBeNull();
      (await store.putActivityHeadlineIfAbsent(task, value))._unsafeUnwrap();
      (
        await store.requestProjectDeletion(task, {
          projectId: project.id,
          now: 2000,
          cleanupAfter: 2000,
        })
      )._unsafeUnwrap();
      expect((await store.putActivityHeadlineIfAbsent(task, value))._unsafeUnwrap()).toBeNull();
      const current = (await store.getOrb(task, orb.id))._unsafeUnwrap();
      assert(current !== null);
      (
        await store.finalizeOrbDeletion(task, {
          orbId: orb.id,
          expectedStateVersion: current.stateVersion,
        })
      )._unsafeUnwrap();
      expect((await store.readActivityHeadlines(task, orb.id, session.id))._unsafeUnwrap()).toEqual(
        [],
      );
      expect((await store.putActivityHeadlineIfAbsent(task, value))._unsafeUnwrap()).toBeNull();
      const parent = (await store.getProject(task, project.id))._unsafeUnwrap();
      assert(parent !== null);
      (
        await store.finalizeProjectDeletion(task, {
          projectId: project.id,
          expectedStateVersion: parent.stateVersion,
        })
      )._unsafeUnwrap();
      expect((await store.putActivityHeadlineIfAbsent(task, value))._unsafeUnwrap()).toBeNull();
    });

    it("retains cached headlines through archival", async () => {
      const value = await seedHeadline();
      (await store.putActivityHeadlineIfAbsent(task, value))._unsafeUnwrap();
      const requested = (
        await store.requestOrbArchive(task, {
          orbId: orb.id,
          expectedStateVersion: 0,
          now: 2000,
          cleanupAfter: 2000,
        })
      )._unsafeUnwrap();
      (
        await store.sealOrbArchive(task, {
          orbId: orb.id,
          expectedStateVersion: requested.stateVersion,
          now: 2000,
          cursor: second.id,
          headId: second.id,
        })
      )._unsafeUnwrap();
      (
        await store.finalizeOrbArchive(task, {
          orbId: orb.id,
          expectedStateVersion: requested.stateVersion,
          now: 2000,
        })
      )._unsafeUnwrap();
      expect((await store.readActivityHeadline(task, value))._unsafeUnwrap()).toEqual(value);
      expect(
        (
          await store.putActivityHeadlineIfAbsent(task, {
            ...value,
            headline: "loser",
            generatedAt: 9999,
          })
        )._unsafeUnwrap(),
      ).toEqual(value);
    });

    it("keeps the first orb time zone when an ID collides at insertion", async () => {
      expect((await store.insertProject(task, project)).isOk()).toBe(true);
      const first = { ...orb, userTimeZone: "Asia/Tokyo" };
      expect((await store.insertOrb(task, first)).isOk()).toBe(true);
      const second = await store.insertOrb(task, { ...orb, userTimeZone: null });
      expect(
        second.isErr() && second.error.type === "project_conflict" && second.error.reason,
      ).toBe("concurrent_change");
      expect((await store.getOrb(task, orb.id))._unsafeUnwrap()?.userTimeZone).toBe("Asia/Tokyo");
    });

    it("publishes only inserted alerts and compare-clears without erasing a newer alert", async () => {
      await seed();
      const alert = (id: string, parentId: string | null): HistoryRecord => ({
        id,
        parentId,
        timestamp: "2026-08-07T00:00:00.000Z",
        type: "event",
        eventType: "pi.custom",
        content: [{ type: "text", text: "\u0000\ud800" }],
        alert: { message: id, requestId: id },
        overflow: { "\udfff": "\u0000" },
      });
      const a = alert("alert-a", null);
      const b = alert("alert-b", a.id);
      const commit = (cursor: string | null, records: HistoryRecord[]) =>
        store.commitPullBatch(task, {
          orbId: orb.id,
          expectedCursor: cursor,
          session,
          records,
          nextCursor: records[records.length - 1]?.id ?? "",
          nextHeadId: records[records.length - 1]?.id ?? "",
        });
      expect((await commit(null, [a]))._unsafeUnwrap().unreadAlertId).toBe(a.id);
      expect((await store.ackOrbAlert(task, orb.id, a.id))._unsafeUnwrap()).toBeNull();
      expect((await commit(a.id, [a, b]))._unsafeUnwrap().unreadAlertId).toBe(b.id);
      expect((await store.ackOrbAlert(task, orb.id, a.id))._unsafeUnwrap()).toBe(b.id);
      expect((await store.ackOrbAlert(task, orb.id, b.id))._unsafeUnwrap()).toBeNull();
      expect((await store.ackOrbAlert(task, orb.id, b.id))._unsafeUnwrap()).toBeNull();
      expect((await store.ackOrbAlert(task, orb.id, "unreplicated"))._unsafeUnwrapErr().type).toBe(
        "alert_not_replicated",
      );
      expect((await store.getOrb(task, orb.id))._unsafeUnwrap()?.unreadAlertId).toBeNull();
      const c = alert("alert-c", b.id);
      const d = alert("alert-d", c.id);
      expect((await commit(b.id, [c, d]))._unsafeUnwrap().unreadAlertId).toBe(d.id);
      expect((await store.ackOrbAlert(task, orb.id, c.id))._unsafeUnwrap()).toBe(d.id);
      expect((await store.ackOrbAlert(task, orb.id, d.id))._unsafeUnwrap()).toBeNull();
      const message: HistoryRecord = { ...first, id: "following", parentId: d.id };
      expect((await commit(d.id, [d, message]))._unsafeUnwrap().unreadAlertId).toBeNull();
      expect((await store.ackOrbAlert(task, orb.id, d.id))._unsafeUnwrap()).toBeNull();
    });

    it("atomically accepts and resolves scheduled sleep with singleton system provenance", async () => {
      const running = {
        ...orb,
        state: "running" as const,
        runtimeTokenHash: "caller",
        hostIncarnation: 2,
      };
      expect((await store.insertProject(task, project)).isOk()).toBe(true);
      expect((await store.insertOrb(task, running)).isOk()).toBe(true);
      const sleepId = "00000000-0000-4000-8000-000000000041";
      const accepted = await store.scheduleOrbSleep(task, {
        orbId: orb.id,
        caller: { runtimeTokenHash: "caller", hostIncarnation: 2 },
        sleepId,
        durationSeconds: 1,
      });
      const acceptedOrb = accepted._unsafeUnwrap();
      expect(acceptedOrb.sleepUntil).not.toBeNull();
      if (acceptedOrb.sleepUntil === null) throw new Error("accepted sleep must have a deadline");
      const deadline = acceptedOrb.sleepUntil;
      expect(acceptedOrb).toMatchObject({ sleepId, stateVersion: 1 });
      expect(
        (
          await store.scheduleOrbSleep(task, {
            orbId: orb.id,
            caller: { runtimeTokenHash: "caller", hostIncarnation: 2 },
            sleepId: "00000000-0000-4000-8000-000000000042",
            durationSeconds: 2,
          })
        ).isErr(),
      ).toBe(true);
      const stopped = await store.casTransition(task, {
        orbId: orb.id,
        expectedStateVersion: 1,
        toState: "stopped",
        now: 2500,
      });
      expect(stopped.isOk()).toBe(true);
      expect(
        (
          await store.processDueOrbSleep(task, {
            orbId: orb.id,
            sleepId,
            expectedStateVersion: 2,
            now: deadline - 1,
          })
        )._unsafeUnwrap(),
      ).toBe("waiting");
      expect(
        (
          await store.processDueOrbSleep(task, {
            orbId: orb.id,
            sleepId,
            expectedStateVersion: 2,
            now: deadline,
          })
        )._unsafeUnwrap(),
      ).toBe("wake");
      expect(
        (
          await store.processDueOrbSleep(task, {
            orbId: orb.id,
            sleepId,
            expectedStateVersion: 2,
            now: deadline,
          })
        )._unsafeUnwrap(),
      ).toBe("stale");
      const messages = (await store.listOrbMessages(task, orb.id))._unsafeUnwrap();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        messageId: sleepId,
        system: { kind: "sleep_wake", sleepUntil: new Date(deadline).toISOString() },
        autoStart: true,
        wakeStateVersion: 3,
      });
      expect(
        (
          await store.casTransition(task, {
            orbId: orb.id,
            expectedStateVersion: 3,
            toState: "starting",
            now: deadline,
          })
        ).isOk(),
      ).toBe(true);
      const bootRequest = {
        orbId: orb.id,
        caller: { runtimeTokenHash: "caller", hostIncarnation: 2 },
      };
      expect((await store.readOrbBootContext(task, bootRequest))._unsafeUnwrap()).toMatchObject({
        messageId: sleepId,
        messageIds: [sleepId],
        system: { kind: "sleep_wake" },
      });
      expect((await store.readOrbBootContext(task, bootRequest))._unsafeUnwrap()?.messageId).toBe(
        sleepId,
      );
    });

    it("atomically registers immutable upload batch membership", async () => {
      await store.insertProject(task, project);
      await store.insertOrb(task, { ...orb, state: "running" });
      const first = { id: "a0000000-0000-4000-8000-000000000001", name: "same.bin", size: 7 };
      const second = { ...first, id: "b0000000-0000-4000-8000-000000000002" };
      const batch = { id: first.id, files: [first, second] };
      const created = await store.uploads.createBatch(task, orb.id, batch, 2001);
      expect(created.isOk(), created.isErr() ? JSON.stringify(created.error) : "").toBe(true);
      const admitted = created._unsafeUnwrap();
      expect(admitted).toHaveLength(2);
      expect(admitted.every((row) => row.batchId === batch.id && row.activeUntil === 302001)).toBe(
        true,
      );
      expect(
        (
          await store.uploads.createBatch(task, orb.id, { ...batch, files: [second, first] }, 2002)
        )._unsafeUnwrap(),
      ).toHaveLength(2);
      expect(
        (await store.uploads.createBatch(task, orb.id, { ...batch, files: [first] }, 2003)).isErr(),
      ).toBe(true);
      expect(
        (
          await store.uploads.createBatch(task, orb.id, { id: second.id, files: [second] }, 2003)
        ).isErr(),
      ).toBe(true);
      expect(
        (
          await store.uploads.createBatch(task, orb.id, { ...batch, files: [first, first] }, 2003)
        ).isErr(),
      ).toBe(true);
      expect((await store.uploads.admit(task, orb.id, second, 2004))._unsafeUnwrap().batchId).toBe(
        batch.id,
      );
      expect((await store.uploads.list(task, orb.id))._unsafeUnwrap()).toHaveLength(2);
    });

    it("persists upload leases, fences idle CAS, and never wakes from upload notification", async () => {
      await store.insertProject(task, project);
      await store.insertOrb(task, { ...orb, state: "running" });
      const spec = { id: "a0000000-0000-4000-8000-000000000001", name: "sample.bin", size: 7 };
      const admitted = (await store.uploads.admit(task, orb.id, spec, 2001))._unsafeUnwrap();
      expect(admitted).toMatchObject({
        ...spec,
        offset: 0,
        status: "transferring",
        activeUntil: 302001,
      });
      const current = (await store.getOrb(task, orb.id))._unsafeUnwrap();
      assert(current !== null);
      expect(
        (
          await store.casTransition(task, {
            orbId: orb.id,
            expectedStateVersion: current.stateVersion,
            toState: "stopping",
            stopReason: "idle",
            now: 2001,
          })
        ).isErr(),
      ).toBe(true);
      expect(
        (await store.uploads.admit(task, orb.id, { ...spec, name: "different.bin" }, 2002)).isErr(),
      ).toBe(true);
      const stored = await store.uploads.record(
        task,
        admitted,
        { offset: 7, path: "/workspace/uploads/sample.bin", status: "stored" },
        2003,
      );
      expect(stored.isOk()).toBe(true);
      const latest = (await store.getOrb(task, orb.id))._unsafeUnwrap();
      assert(latest !== null);
      expect(
        (
          await store.casTransition(task, {
            orbId: orb.id,
            expectedStateVersion: latest.stateVersion,
            toState: "stopped",
            now: 2004,
          })
        ).isOk(),
      ).toBe(true);
      expect((await store.uploads.admit(task, orb.id, spec, 2005)).isErr()).toBe(true);
      const message = {
        orbId: orb.id,
        messageId: spec.id,
        content: [{ type: "text" as const, text: "uploaded sample.bin" }],
        now: 2005,
        wake: false,
        cancelSleep: false,
      };
      expect((await store.enqueueOrbMessage(task, message))._unsafeUnwrap().message.autoStart).toBe(
        false,
      );
      expect((await store.enqueueOrbMessage(task, message))._unsafeUnwrap().duplicate).toBe(true);
      expect((await store.listOrbMessages(task, orb.id))._unsafeUnwrap()).toHaveLength(1);
    });

    function peerCentralCaller(orbId: string): CentralAgentCaller {
      return {
        kind: "central",
        ownerUserId: OWNER,
        projectId: project.id,
        orbId,
        agentAdmissionVersion: 0,
      };
    }

    it("canonicalizes existing human uppercase UUID targets without changing dedupe", async () => {
      await seed();
      const human = { ...orb, id: "abcdef00-0000-4000-8000-000000000009" };
      (await store.insertOrb(task, human))._unsafeUnwrap();
      const params = {
        orbId: human.id.toUpperCase(),
        messageId: "00000000-0000-4000-8000-000000000008",
        content: [{ type: "text" as const, text: "human" }],
        now: 2000,
      };
      expect((await store.enqueueOrbMessage(task, params))._unsafeUnwrap().message.orbId).toBe(
        human.id,
      );
      expect(
        (await store.enqueueOrbMessage(task, { ...params, orbId: human.id }))._unsafeUnwrap()
          .duplicate,
      ).toBe(true);
      expect((await store.listOrbMessages(task, human.id))._unsafeUnwrap()).toHaveLength(1);
    });

    it.each(["sender", "target"])("serializes reciprocal sends vs %s deletion", async (side) => {
      await seed();
      const peerProject = { ...project, id: "00000000-0000-4000-8000-000000000010", name: "peer" };
      (await store.insertProject(task, peerProject))._unsafeUnwrap();
      const peer = {
        ...orb,
        id: "00000000-0000-4000-8000-000000000003",
        projectId: peerProject.id,
      };
      (await store.insertOrb(task, peer))._unsafeUnwrap();
      const sender = (source: OrbRow) => ({
        orbId: source.id,
        projectId: source.projectId,
        ownerUserId: OWNER,
        caller: { ...peerCentralCaller(source.id), projectId: source.projectId },
      });
      const params = {
        orbId: orb.id,
        messageId: "00000000-0000-4000-8000-000000000004",
        content: [{ type: "text" as const, text: "peer" }],
        now: 2000,
        sender: sender(peer),
      };
      const results = await Promise.all([
        store.enqueueOrbMessage(task, params),
        store.enqueueOrbMessage(task, { ...params, orbId: peer.id, sender: sender(orb) }),
      ]);
      expect(results.every((result) => result.isOk())).toBe(true);
      const race = await Promise.all([
        store.enqueueOrbMessage(task, {
          ...params,
          messageId: "00000000-0000-4000-8000-000000000005",
        }),
        store.requestProjectDeletion(task, {
          projectId: side === "sender" ? peerProject.id : project.id,
          now: 3000,
          cleanupAfter: 3000,
        }),
      ]);
      expect(race[1]?.isOk()).toBe(true);
      const inbox = (await store.listOrbMessages(task, orb.id))._unsafeUnwrap();
      expect(inbox.some((row) => row.messageId === "00000000-0000-4000-8000-000000000005")).toBe(
        race[0]?.isOk(),
      );
      expect((await store.enqueueOrbMessage(task, params)).isErr()).toBe(true);
    });

    it("atomically admits trusted peer provenance, dedupes without renewing wake, and fences callers", async () => {
      await seed();
      (
        await store.casTransition(task, {
          orbId: orb.id,
          expectedStateVersion: 0,
          toState: "stopped",
          stopReason: "manual",
          now: 1500,
        })
      )._unsafeUnwrap();
      const sourceProject = {
        ...project,
        id: "00000000-0000-4000-8000-000000000010",
        name: "peer",
      };
      (await store.insertProject(task, sourceProject))._unsafeUnwrap();
      const source = {
        ...orb,
        projectId: sourceProject.id,
        id: "00000000-0000-4000-8000-000000000003",
        state: "running" as const,
        runtimeTokenHash: "peer-token",
        hostIncarnation: 1,
      };
      expect((await store.insertOrb(task, source)).isOk()).toBe(true);
      const params = {
        orbId: orb.id,
        messageId: "00000000-0000-4000-8000-000000000004",
        content: [{ type: "text" as const, text: "private peer content" }],
        now: 2000,
        sender: {
          orbId: source.id,
          projectId: source.projectId,
          ownerUserId: OWNER,
          caller: { runtimeTokenHash: "peer-token", hostIncarnation: 1 },
        },
      };
      const results = await Promise.all([
        store.enqueueOrbMessage(task, params),
        store.enqueueOrbMessage(task, params),
      ]);
      expect(results.map((r) => r._unsafeUnwrap().duplicate).sort()).toEqual([false, true]);
      const accepted = results[0];
      expect(accepted).toBeDefined();
      if (!accepted) return;
      expect(accepted._unsafeUnwrap().message.system).toEqual({
        kind: "orb_message",
        senderOrbId: source.id,
      });
      const incompatibleRetries = [
        { ...params, content: [{ type: "text" as const, text: "changed" }] },
        {
          orbId: params.orbId,
          messageId: params.messageId,
          content: params.content,
          now: params.now,
        },
      ];
      for (const retry of incompatibleRetries)
        expect((await store.enqueueOrbMessage(task, retry)).isErr()).toBe(true);
      for (const sender of [
        { ...params.sender, ownerUserId: "wrong" },
        { ...params.sender, projectId: "00000000-0000-4000-8000-000000000005" },
        { ...params.sender, caller: { runtimeTokenHash: "old", hostIncarnation: 1 } },
        { ...params.sender, caller: { runtimeTokenHash: "peer-token", hostIncarnation: 2 } },
        {
          ...params.sender,
          caller: {
            ...peerCentralCaller(source.id),
            projectId: source.projectId,
            agentAdmissionVersion: 9,
          },
        },
      ])
        expect((await store.enqueueOrbMessage(task, { ...params, sender })).isErr()).toBe(true);
      const target = accepted._unsafeUnwrap().orb;
      expect(accepted._unsafeUnwrap().message.autoStart).toBe(true);
      const stopped = (
        await store.requestOrbStop(task, {
          orbId: orb.id,
          expectedStateVersion: target.stateVersion,
          now: 3000,
        })
      )._unsafeUnwrap().orb;
      expect((await store.enqueueOrbMessage(task, params))._unsafeUnwrap().duplicate).toBe(true);
      const retried = (await store.getOrb(task, orb.id))._unsafeUnwrap();
      expect(retried?.stopReason).toBe("manual");
      expect(retried?.stateVersion).toBe(stopped.stateVersion);
      expect((await store.listOrbMessages(task, orb.id))._unsafeUnwrap()).toMatchObject([
        { autoStart: false },
      ]);
      await store.requestProjectDeletion(task, {
        projectId: project.id,
        now: 4000,
        cleanupAfter: 4000,
      });
      expect((await store.enqueueOrbMessage(task, params)).isErr()).toBe(true);
    });

    it.each(["sender", "target"] as const)(
      "orders peer admission against %s Stop",
      async (side) => {
        await seed();
        const source = { ...orb, id: "00000000-0000-4000-8000-000000000003" };
        (await store.insertOrb(task, source))._unsafeUnwrap();
        const params = {
          orbId: orb.id,
          messageId: "00000000-0000-4000-8000-000000000004",
          content: [{ type: "text" as const, text: "peer" }],
          now: 2000,
          sender: {
            orbId: source.id,
            projectId: project.id,
            ownerUserId: OWNER,
            caller: peerCentralCaller(source.id),
          },
        };
        const [admitted, stopped] = await Promise.all([
          store.enqueueOrbMessage(task, params),
          store.requestOrbStop(task, {
            orbId: side === "sender" ? source.id : orb.id,
            expectedStateVersion: 0,
            now: 2001,
          }),
        ]);
        expect(stopped.isOk()).toBe(true);
        const rows = (await store.listOrbMessages(task, orb.id))._unsafeUnwrap();
        expect(rows).toHaveLength(admitted.isOk() ? 1 : 0);
        const before = (await store.getOrb(task, orb.id))._unsafeUnwrap();
        const replay = await store.enqueueOrbMessage(task, params);
        expect(replay.isOk()).toBe(side === "target");
        if (side === "target") {
          expect(admitted.isOk()).toBe(true);
          expect(replay._unsafeUnwrap().duplicate).toBe(true);
          expect((await store.getOrb(task, orb.id))._unsafeUnwrap()).toEqual(before);
        }
      },
    );

    it.each(
      (["running", "stopped", "failed"] as const).flatMap((state) =>
        [false, true].flatMap((claimed) =>
          ["central", "runtime"].map((caller) => ({ state, claimed, caller })),
        ),
      ),
    )(
      "preserves mixed FIFO through Sleep/Stop: $state $caller claimed=$claimed",
      async ({ state, claimed, caller }) => {
        await seed();
        const running = {
          ...orb,
          state: "running" as const,
          runtimeTokenHash: "peer-token",
          hostIncarnation: 1,
        };
        (
          await store.casTransition(task, {
            orbId: orb.id,
            expectedStateVersion: 0,
            toState: "stopped",
            now: 1,
          })
        )._unsafeUnwrap();
        const source = { ...running, id: "00000000-0000-4000-8000-000000000003" };
        (await store.insertOrb(task, source))._unsafeUnwrap();
        const sender = {
          orbId: source.id,
          projectId: project.id,
          ownerUserId: OWNER,
          caller:
            caller === "central"
              ? peerCentralCaller(source.id)
              : { runtimeTokenHash: "peer-token", hostIncarnation: 1 },
        };
        const enqueue = (messageId: string) =>
          store.enqueueOrbMessage(task, {
            orbId: orb.id,
            messageId,
            sender,
            content: [{ type: "text" as const, text: messageId }],
            now: 1,
          });
        const oldId = "00000000-0000-4000-8000-000000000004",
          freshId = "00000000-0000-4000-8000-000000000005",
          sleepId = "00000000-0000-4000-8000-000000000006";
        expect((await enqueue(oldId))._unsafeUnwrap().message.autoStart).toBe(true);
        for (const [index, toState] of (["starting", "running"] as const).entries())
          (
            await store.casTransition(task, {
              orbId: orb.id,
              expectedStateVersion: index + 1,
              toState,
              now: 1,
            })
          )._unsafeUnwrap();
        const humanId = "00000000-0000-4000-8000-000000000007";
        (
          await store.enqueueOrbMessage(task, {
            orbId: orb.id,
            messageId: humanId,
            content: [{ type: "text", text: "human" }],
            now: 2,
          })
        )._unsafeUnwrap();
        if (claimed)
          expect(
            (await store.claimNextOrbMessageBatch(task, { orbId: orb.id, now: 2 }))
              ._unsafeUnwrap()
              .map((row) => row.messageId),
          ).toEqual([oldId]);
        const sleepCaller = (await store.getOrb(task, orb.id))._unsafeUnwrap();
        assert(sleepCaller !== null);
        const sleeping = (
          await store.scheduleOrbSleep(task, {
            orbId: orb.id,
            caller: {
              ...peerCentralCaller(orb.id),
              agentAdmissionVersion: sleepCaller.agentAdmissionVersion,
            },
            sleepId,
            durationSeconds: 300,
          })
        )._unsafeUnwrap();
        const terminal =
          state === "running"
            ? sleeping
            : (
                await store.casTransition(task, {
                  orbId: orb.id,
                  expectedStateVersion: sleeping.stateVersion,
                  toState: state,
                  now: 2,
                })
              )._unsafeUnwrap();
        for (const now of [(sleeping.sleepUntil ?? 0) - 1, (sleeping.sleepUntil ?? 0) + 1]) {
          const start = await store.casStartOrbForQueuedMessage(task, {
            orbId: orb.id,
            expectedStateVersion: terminal.stateVersion,
            now,
          });
          if (state === "running")
            expect(start._unsafeUnwrapErr()).toMatchObject({ type: "state_conflict" });
          else expect(start._unsafeUnwrap()).toBeNull();
        }
        expect((await enqueue(oldId))._unsafeUnwrap().duplicate).toBe(true);
        expect((await store.getOrb(task, orb.id))._unsafeUnwrap()?.sleepId).toBe(sleepId);
        expect(
          (await store.claimNextOrbMessageBatch(task, { orbId: orb.id, now: 3 }))._unsafeUnwrap(),
        ).toEqual([]);
        const fresh = (await enqueue(freshId))._unsafeUnwrap();
        expect(fresh.orb).toMatchObject({ sleepId: null, sleepUntil: null });
        if (state !== "running")
          (
            await store.casStartOrbForQueuedMessage(task, {
              orbId: orb.id,
              expectedStateVersion: fresh.orb.stateVersion,
              now: 4,
            })
          )._unsafeUnwrap();
        expect(
          (await store.claimNextOrbMessageBatch(task, { orbId: orb.id, now: 5 }))
            ._unsafeUnwrap()
            .map((row) => row.messageId),
        ).toEqual([oldId]);
        (
          await store.commitPullBatch(task, {
            orbId: orb.id,
            expectedCursor: null,
            session,
            records: [
              {
                ...first,
                type: "event",
                eventType: "orb.message",
                id: "peer-receipt",
                content: [{ type: "text", text: oldId }],
                sender: { orbId: source.id },
                inboxMessageIds: [oldId],
              },
            ],
            nextCursor: "peer-receipt",
            nextHeadId: "peer-receipt",
          })
        )._unsafeUnwrap();
        expect(
          (await store.claimNextOrbMessageBatch(task, { orbId: orb.id, now: 5 }))
            ._unsafeUnwrap()
            .map((row) => row.messageId),
        ).toEqual([humanId]);
        const beforeSleep = (await store.getOrb(task, orb.id))._unsafeUnwrap();
        assert(beforeSleep !== null);
        if (beforeSleep.state !== "running")
          (
            await store.casTransition(task, {
              orbId: orb.id,
              expectedStateVersion: beforeSleep.stateVersion,
              toState: "running",
              now: 5,
            })
          )._unsafeUnwrap();
        const laterSleepCaller = (await store.getOrb(task, orb.id))._unsafeUnwrap();
        assert(laterSleepCaller !== null);
        const laterSleep = (
          await store.scheduleOrbSleep(task, {
            orbId: orb.id,
            caller: {
              ...peerCentralCaller(orb.id),
              agentAdmissionVersion: laterSleepCaller.agentAdmissionVersion,
            },
            sleepId: freshId,
            durationSeconds: 300,
          })
        )._unsafeUnwrap();
        expect((await enqueue(freshId))._unsafeUnwrap().duplicate).toBe(true);
        expect((await store.getOrb(task, orb.id))._unsafeUnwrap()).toMatchObject({
          sleepId: freshId,
          sleepUntil: laterSleep.sleepUntil,
        });
        expect(
          (await store.listOrbMessages(task, orb.id))._unsafeUnwrap().map((row) => row.system),
        ).toEqual([
          { kind: "orb_message", senderOrbId: source.id },
          null,
          { kind: "orb_message", senderOrbId: source.id },
        ]);
        const current = (await store.getOrb(task, orb.id))._unsafeUnwrap();
        if (!current) throw new Error("seeded orb missing");
        (
          await store.requestOrbStop(task, {
            orbId: orb.id,
            expectedStateVersion: current.stateVersion,
            now: 6,
          })
        )._unsafeUnwrap();
        expect((await enqueue(freshId))._unsafeUnwrap().duplicate).toBe(true);
        expect((await store.getOrb(task, orb.id))._unsafeUnwrap()?.stopReason).toBe("manual");
        expect(
          (await store.listOrbMessages(task, orb.id))
            ._unsafeUnwrap()
            .every((row) => !row.autoStart),
        ).toBe(true);
        expect(
          (await store.listOrbMessages(task, orb.id))
            ._unsafeUnwrap()
            .find((row) => row.messageId === freshId),
        ).toMatchObject({
          status: "queued",
          autoStart: false,
          system: { kind: "orb_message", senderOrbId: source.id },
        });
      },
    );

    it("lists existing direct spawn children with current names, including archived targets", async () => {
      await seed();
      const childId = "00000000-0000-4000-8000-000000000003";
      const unnamedId = "00000000-0000-4000-8000-000000000004";
      const grandchildId = "00000000-0000-4000-8000-000000000005";
      const unrelatedId = "00000000-0000-4000-8000-000000000006";
      expect((await store.listSpawnChildren(task, orb.id))._unsafeUnwrap()).toEqual([]);
      expect((await store.insertOrb(task, { ...orb, id: unrelatedId })).isOk()).toBe(true);
      for (const [id, callerOrbId] of [
        [unnamedId, orb.id],
        [childId, orb.id],
        [grandchildId, childId],
      ] as const) {
        expect(
          (
            await store.spawnOrb(task, {
              callerOrbId,
              caller: peerCentralCaller(callerOrbId),
              orb: { ...orb, id },
              prompt: "work",
              requestHash: id,
            })
          ).isOk(),
        ).toBe(true);
      }
      expect(
        (
          await store.setOrbName(task, {
            orbId: childId,
            name: "Renamed",
            now: 2000,
            onlyIfNull: false,
          })
        ).isOk(),
      ).toBe(true);
      expect(
        (
          await store.casTransition(task, {
            orbId: childId,
            expectedStateVersion: 0,
            toState: "archived",
            now: 2001,
          })
        ).isOk(),
      ).toBe(true);
      const expected = [
        { id: childId, name: "Renamed" },
        { id: unnamedId, name: null },
      ];
      expect((await store.listSpawnChildren(task, orb.id))._unsafeUnwrap()).toEqual(expected);
      expect((await store.listSpawnChildren(task, childId))._unsafeUnwrap()).toEqual([
        { id: grandchildId, name: null },
      ]);
      for (const [orbId, now] of [
        [unnamedId, 2002],
        [orb.id, 2003],
      ] as const) {
        const deleting = (
          await store.requestOrbDeletion(task, {
            orbId,
            expectedStateVersion: 0,
            now,
            cleanupAfter: now,
          })
        )._unsafeUnwrap();
        if (orbId === unnamedId)
          expect((await store.listSpawnChildren(task, orb.id))._unsafeUnwrap()).toEqual(expected);
        expect(
          (
            await store.finalizeOrbDeletion(task, {
              orbId,
              expectedStateVersion: deleting.stateVersion,
            })
          ).isOk(),
        ).toBe(true);
        if (orbId === unnamedId)
          expect((await store.listSpawnChildren(task, orb.id))._unsafeUnwrap()).toEqual([
            { id: childId, name: "Renamed" },
          ]);
      }
      expect((await store.getSpawnCaller(task, childId))._unsafeUnwrap()).toBe(orb.id);
    });

    it.each([
      null,
      { provider: "claude", id: "opus" },
      { provider: "openai-codex", id: "gpt-6.1-sol" },
    ])("atomically spawns with intent %j and fences retired callers", async (initialModel) => {
      expect((await store.insertProject(task, project)).isOk()).toBe(true);
      const caller = {
        ...orb,
        state: "running" as const,
        runtimeTokenHash: "caller-token",
        hostIncarnation: 1,
        userTimeZone: "America/New_York",
        harness: "claude" as const,
        initialModel: { provider: "claude", id: "sonnet" },
      };
      expect((await store.insertOrb(task, caller)).isOk()).toBe(true);
      const child = {
        ...orb,
        id: "00000000-0000-4000-8000-000000000003",
        initialModel,
        harness: initialModel?.provider === "claude" ? ("claude" as const) : ("pi" as const),
      };
      const params = {
        callerOrbId: caller.id,
        expectedOwnerUserId: project.ownerUserId,
        caller: { runtimeTokenHash: "caller-token", hostIncarnation: 1 },
        orb: child,
        prompt: "Do the work",
        requestHash: "immutable-request",
      };
      const ownerDenied = await store.spawnOrb(task, {
        ...params,
        expectedOwnerUserId: "previous-owner",
      });
      expect(ownerDenied.isErr() && ownerDenied.error.type).toBe("spawn_conflict");
      expect((await store.getOrb(task, child.id))._unsafeUnwrap()).toBeNull();
      expect((await store.getSpawnCaller(task, child.id))._unsafeUnwrap()).toBeNull();
      expect((await store.listOrbMessages(task, child.id))._unsafeUnwrap()).toEqual([]);
      const accepted = await store.spawnOrb(task, params);
      expect(accepted.isOk() && accepted.value.duplicate).toBe(false);
      expect((await store.getSpawnCaller(task, child.id))._unsafeUnwrap()).toBe(caller.id);
      expect((await store.getSpawnCaller(task, caller.id))._unsafeUnwrap()).toBeNull();
      expect((await store.getOrb(task, child.id))._unsafeUnwrap()).toMatchObject({
        state: "creating",
        harness: initialModel === null ? "claude" : child.harness,
        initialModel,
        userTimeZone: "America/New_York",
      });
      expect((await store.listOrbMessages(task, child.id))._unsafeUnwrap()).toMatchObject([
        { messageId: child.id, content: [{ type: "text", text: "Do the work" }], status: "queued" },
      ]);
      await store.setOrbName(task, {
        orbId: child.id,
        name: "Changed later",
        now: 2000,
        onlyIfNull: false,
      });
      await store.claimNextOrbMessageBatch(task, { orbId: child.id, now: 2000 });
      const retry = await store.spawnOrb(task, params);
      expect(retry.isOk() && retry.value.duplicate).toBe(true);
      expect((await store.getOrb(task, child.id))._unsafeUnwrap()?.userTimeZone).toBe(
        "America/New_York",
      );
      const conflict = await store.spawnOrb(task, {
        ...params,
        requestHash: "different-request",
        prompt: "Different",
      });
      expect(conflict.isErr() && conflict.error.type).toBe("spawn_conflict");
      expect((await store.listOrbMessages(task, child.id))._unsafeUnwrap()).toHaveLength(1);
      const deniedId = "00000000-0000-4000-8000-000000000004";
      const denied = await store.spawnOrb(task, {
        ...params,
        orb: { ...child, id: deniedId },
        caller: { ...params.caller, hostIncarnation: 2 },
      });
      expect(denied.isErr() && denied.error.type).toBe("spawn_conflict");
      expect((await store.getOrb(task, deniedId))._unsafeUnwrap()).toBeNull();
      expect((await store.listOrbMessages(task, deniedId))._unsafeUnwrap()).toEqual([]);
      await store.requestProjectDeletion(task, {
        projectId: project.id,
        now: 3000,
        cleanupAfter: 3000,
      });
      expect((await store.spawnOrb(task, params)).isErr()).toBe(true);
    });

    it("lists immutable spawn provenance through caller archival and deletion", async () => {
      (await store.insertProject(task, project))._unsafeUnwrap();
      const caller = { ...orb, state: "running" as const, runtimeTokenHash: "token" };
      (await store.insertOrb(task, caller))._unsafeUnwrap();
      const child = { ...orb, id: "00000000-0000-4000-8000-000000000003" };
      (
        await store.spawnOrb(task, {
          callerOrbId: caller.id,
          caller: { runtimeTokenHash: "token", hostIncarnation: 0 },
          orb: child,
          prompt: "work",
          requestHash: "hash",
        })
      )._unsafeUnwrap();
      const otherProject = {
        ...project,
        id: "00000000-0000-4000-8000-000000000004",
        name: "other",
      };
      (await store.insertProject(task, otherProject))._unsafeUnwrap();
      (
        await store.insertOrb(task, {
          ...orb,
          id: "00000000-0000-4000-8000-000000000005",
          projectId: otherProject.id,
        })
      )._unsafeUnwrap();
      const read = async () => (await store.listOrbsByProject(task, project.id))._unsafeUnwrap();
      const expectRelation = async () => {
        const rows = await read();
        expect(rows.map((row) => row.id).sort()).toEqual([caller.id, child.id].sort());
        expect(rows.find((row) => row.id === caller.id)).toMatchObject({ spawnedByOrb: null });
        expect(rows.find((row) => row.id === child.id)).toMatchObject({ spawnedByOrb: caller.id });
      };
      await expectRelation();
      (
        await store.setOrbName(task, {
          orbId: child.id,
          name: "Renamed",
          now: 1500,
          onlyIfNull: false,
        })
      )._unsafeUnwrap();
      const archive = (
        await store.requestOrbArchive(task, {
          orbId: caller.id,
          expectedStateVersion: 0,
          now: 2000,
          cleanupAfter: 2000,
        })
      )._unsafeUnwrap();
      await expectRelation();
      (
        await store.sealOrbArchive(task, {
          orbId: caller.id,
          expectedStateVersion: archive.stateVersion,
          now: 2500,
          cursor: null,
          headId: null,
        })
      )._unsafeUnwrap();
      const archived = (
        await store.finalizeOrbArchive(task, {
          orbId: caller.id,
          expectedStateVersion: archive.stateVersion,
          now: 3000,
        })
      )._unsafeUnwrap();
      await expectRelation();
      const deletion = (
        await store.requestOrbDeletion(task, {
          orbId: caller.id,
          expectedStateVersion: archived.stateVersion,
          now: 4000,
          cleanupAfter: 4000,
        })
      )._unsafeUnwrap();
      await expectRelation();
      (
        await store.finalizeOrbDeletion(task, {
          orbId: caller.id,
          expectedStateVersion: deletion.stateVersion,
        })
      )._unsafeUnwrap();
      expect(await read()).toMatchObject([
        { id: child.id, name: "Renamed", spawnedByOrb: caller.id },
      ]);
      expect((await store.getSpawnCaller(task, child.id))._unsafeUnwrap()).toBe(caller.id);
      const childDeletion = (
        await store.requestOrbDeletion(task, {
          orbId: child.id,
          expectedStateVersion: 0,
          now: 5000,
          cleanupAfter: 5000,
        })
      )._unsafeUnwrap();
      (
        await store.finalizeOrbDeletion(task, {
          orbId: child.id,
          expectedStateVersion: childDeletion.stateVersion,
        })
      )._unsafeUnwrap();
      expect(await read()).toEqual([]);
      expect((await store.getSpawnCaller(task, child.id))._unsafeUnwrap()).toBe(caller.id);
      const projectDeletion = (
        await store.requestProjectDeletion(task, {
          projectId: project.id,
          now: 6000,
          cleanupAfter: 6000,
        })
      )._unsafeUnwrap();
      (
        await store.finalizeProjectDeletion(task, {
          projectId: project.id,
          expectedStateVersion: projectDeletion.project.stateVersion,
        })
      )._unsafeUnwrap();
      expect((await store.getSpawnCaller(task, child.id))._unsafeUnwrap()).toBeNull();
    });

    it("serializes concurrent spawn retries and project deletion", async () => {
      expect((await store.insertProject(task, project)).isOk()).toBe(true);
      expect(
        (
          await store.insertOrb(task, { ...orb, state: "running", runtimeTokenHash: "token" })
        ).isOk(),
      ).toBe(true);
      const params = {
        callerOrbId: orb.id,
        caller: { runtimeTokenHash: "token", hostIncarnation: 0 },
        orb: { ...orb, id: "00000000-0000-4000-8000-000000000003" },
        prompt: "work",
        requestHash: "hash",
      };
      const retries = await Promise.all([
        store.spawnOrb(task, params),
        store.spawnOrb(task, params),
      ]);
      expect(retries.map((result) => result._unsafeUnwrap().duplicate).sort()).toEqual([
        false,
        true,
      ]);
      const racing = {
        ...params,
        orb: { ...params.orb, id: "00000000-0000-4000-8000-000000000004" },
      };
      const [created, deleted] = await Promise.all([
        store.spawnOrb(task, racing),
        store.requestProjectDeletion(task, {
          projectId: project.id,
          now: 2000,
          cleanupAfter: 2000,
        }),
      ]);
      expect(deleted.isOk()).toBe(true);
      const child = (await store.getOrb(task, racing.orb.id))._unsafeUnwrap();
      expect(child?.state ?? null).toBe(created.isOk() ? "deleting" : null);
      expect((await store.listOrbMessages(task, racing.orb.id))._unsafeUnwrap()).toHaveLength(
        created.isOk() ? 1 : 0,
      );
    });

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

    it("charges restarts and fails a budget-exhausted orb with its agent suspended", async () => {
      await seed();
      const charged = await store.casUpdateFields(task, {
        orbId: orb.id,
        expectedStateVersion: 0,
        now: 2_000,
        autoRestartTimes: [1_000, 2_000],
      });
      expect(charged.isOk() && charged.value.autoRestartTimes).toEqual([1_000, 2_000]);
      const failed = await store.failOrbAndRequestComputeDiscard(task, {
        orbId: orb.id,
        expectedStateVersion: 1,
        now: 3_000,
        lastError: "restart_budget_exhausted: budget",
        suspendAgent: true,
      });
      expect(failed.isOk() && failed.value).toMatchObject({
        state: "failed",
        stopReason: "manual",
        agentAdmissionVersion: orb.agentAdmissionVersion + 1,
        autoRestartTimes: [1_000, 2_000],
      });
    });

    it("claims a Claude ownership episode once and creates proof only at fenced finalization", async () => {
      await store.insertProject(task, project);
      await store.insertOrb(task, {
        ...orb,
        harness: "claude",
        state: "running",
        hostRef: "old",
        runtimeTokenHash: "old-token",
        hostDiscardEvidence: "previous compute evidence",
      });
      const params = {
        orbId: orb.id,
        expectedStateVersion: 0,
        now: 2_000,
        lastError: "guard",
        recoveryEpisode: "a".repeat(64),
      };
      const claimed = await store.failOrbAndRequestComputeDiscard(task, params);
      expect(claimed.isOk()).toBe(true);
      if (claimed.isErr()) return;
      expect(claimed.value.claudeRecovery).toEqual({
        episode: params.recoveryEpisode,
        disposedIncarnation: 0,
        replacementIncarnation: 1,
        verified: false,
        claimedEpisodes: [params.recoveryEpisode],
      });
      expect(claimed.value.runtimeTokenHash).toBeNull();
      expect(claimed.value.hostDiscardEvidence).toBeNull();
      expect((await store.failOrbAndRequestComputeDiscard(task, params)).isErr()).toBe(true);
      const stale = await store.finalizeHostDiscard(task, {
        orbId: orb.id,
        expectedStateVersion: 0,
        throughIncarnation: 0,
        now: 3_000,
      });
      expect(stale.isErr()).toBe(true);
      const finalized = await store.finalizeHostDiscard(task, {
        orbId: orb.id,
        expectedStateVersion: claimed.value.stateVersion,
        throughIncarnation: 0,
        now: 3_000,
      });
      expect(finalized.isOk()).toBe(true);
      if (finalized.isErr()) return;
      expect(finalized.value.claudeRecovery?.verified).toBe(true);
      expect(finalized.value.hostIncarnation).toBe(1);
      const later = await store.failOrbAndRequestComputeDiscard(task, {
        ...params,
        expectedStateVersion: finalized.value.stateVersion,
        recoveryEpisode: "b".repeat(64),
      });
      expect(later.isOk()).toBe(true);
      if (later.isErr()) return;
      const laterFinalized = await store.finalizeHostDiscard(task, {
        orbId: orb.id,
        expectedStateVersion: later.value.stateVersion,
        throughIncarnation: 1,
        now: 4_000,
      });
      expect(laterFinalized.isOk()).toBe(true);
      if (laterFinalized.isErr()) return;
      expect(laterFinalized.value.claudeRecovery?.claimedEpisodes).toEqual([
        params.recoveryEpisode,
        "b".repeat(64),
      ]);
      expect(
        (
          await store.failOrbAndRequestComputeDiscard(task, {
            ...params,
            expectedStateVersion: laterFinalized.value.stateVersion,
          })
        ).isErr(),
      ).toBe(true);
      expect(
        (
          await store.failOrbAndRequestComputeDiscard(task, {
            ...params,
            expectedStateVersion: finalized.value.stateVersion,
          })
        ).isErr(),
      ).toBe(true);
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
        expectedStateVersion: 2,
        throughIncarnation: 0,
        now: 5_000,
      });
      expect(finalized.isOk() && finalized.value).toMatchObject({
        hostRef: null,
        stateVersion: 3,
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

    it("rejects stale provision commits across replacement request and finalization", async () => {
      await seed();
      const hosted = await store.casUpdateFields(task, {
        orbId: orb.id,
        expectedStateVersion: 0,
        expectedHostIncarnation: 0,
        now: 2_000,
        hostRef: "pi-orb-orb-1-i0",
        runtimeTokenHash: "old-token-hash",
        hostSpecFingerprint: "spec-old",
        hostSpecGeneration: 10,
      });
      expect(hosted.isOk()).toBe(true);

      const requested = await store.requestHostSpecReplacement(task, {
        orbId: orb.id,
        expectedStateVersion: 1,
        desiredFingerprint: "spec-new",
        configuredGeneration: 11,
        now: 3_000,
      });
      expect(requested.isOk() && requested.value).toMatchObject({
        type: "requested",
        orb: { stateVersion: 2 },
      });

      const staleDuringDiscard = await store.casUpdateFields(task, {
        orbId: orb.id,
        expectedStateVersion: 2,
        expectedHostIncarnation: 0,
        now: 3_500,
        hostRef: "pi-orb-orb-1-i0-stale",
        runtimeTokenHash: "stale-token-hash",
        hostSpecFingerprint: "spec-old",
        hostSpecGeneration: 10,
      });
      expect(staleDuringDiscard.isErr() && staleDuringDiscard.error.type).toBe("state_conflict");

      const finalized = await store.finalizeHostDiscard(task, {
        orbId: orb.id,
        expectedStateVersion: 2,
        throughIncarnation: 0,
        now: 4_000,
      });
      expect(finalized.isOk() && finalized.value).toMatchObject({
        stateVersion: 3,
        hostRef: null,
        hostIncarnation: 1,
      });

      const staleAfterFinalize = await store.casUpdateFields(task, {
        orbId: orb.id,
        expectedStateVersion: 3,
        expectedHostIncarnation: 0,
        now: 4_500,
        hostRef: "pi-orb-orb-1-i0-stale",
        runtimeTokenHash: "stale-token-hash",
        hostSpecFingerprint: "spec-old",
        hostSpecGeneration: 10,
      });
      expect(staleAfterFinalize.isErr() && staleAfterFinalize.error.type).toBe("state_conflict");
      expect((await store.getOrb(task, orb.id))._unsafeUnwrap()).toMatchObject({
        stateVersion: 3,
        hostRef: null,
        hostIncarnation: 1,
        hostSpecFingerprint: "spec-new",
        hostSpecGeneration: 11,
      });
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
        expectedStateVersion: 3,
        throughIncarnation: 0,
        now: 5_000,
      });
      expect(finalized.isOk() && finalized.value).toMatchObject({
        hostRef: null,
        stateVersion: 4,
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
        expectedStateVersion: 4,
        expectedHostIncarnation: 1,
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
        expectedStateVersion: 2,
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

    it("claims the mint rate-limit slot atomically and only moves it forward", async () => {
      await seed();
      const running = await store.casTransition(task, {
        orbId: orb.id,
        expectedStateVersion: 0,
        toState: "running",
        now: 2_000,
      });
      expect(running.isOk()).toBe(true);

      // A never-minted orb claims immediately, and the claim is the write:
      // the floor is at the claim's own timestamp afterwards.
      const first = await store.claimMintSlot(task, {
        orbId: orb.id,
        at: 5_000,
        minIntervalMs: 2_000,
      });
      expect(first._unsafeUnwrap()).toEqual({ claimed: true });
      expect((await store.getOrb(task, orb.id))._unsafeUnwrap()).toMatchObject({
        lastMintAt: 5_000,
        stateVersion: 1,
        stateChangedAt: 2_000,
      });

      const throttled = await store.claimMintSlot(task, {
        orbId: orb.id,
        at: 5_500,
        minIntervalMs: 2_000,
      });
      expect(throttled._unsafeUnwrap()).toEqual({ claimed: false, retryAfterMs: 1_500 });
      expect((await store.getOrb(task, orb.id))._unsafeUnwrap()?.lastMintAt).toBe(5_000);

      // A late-arriving claim from another instance carries an older `at`; it
      // must not move the floor backwards and hand the next caller a free mint.
      const late = await store.claimMintSlot(task, {
        orbId: orb.id,
        at: 4_000,
        minIntervalMs: 2_000,
      });
      expect(late._unsafeUnwrap().claimed).toBe(false);
      expect((await store.getOrb(task, orb.id))._unsafeUnwrap()?.lastMintAt).toBe(5_000);

      // Exactly at the interval boundary the slot is free again.
      const after = await store.claimMintSlot(task, {
        orbId: orb.id,
        at: 7_000,
        minIntervalMs: 2_000,
      });
      expect(after._unsafeUnwrap()).toEqual({ claimed: true });
      expect((await store.getOrb(task, orb.id))._unsafeUnwrap()?.lastMintAt).toBe(7_000);

      // Nothing to throttle: an orb id with no row is refused for the full
      // interval rather than granted a claim it has no floor to record.
      const unknown = await store.claimMintSlot(task, {
        orbId: "00000000-0000-4000-8000-0000000000cd",
        at: 9_000,
        minIntervalMs: 2_000,
      });
      expect(unknown._unsafeUnwrap()).toEqual({ claimed: false, retryAfterMs: 2_000 });
    });

    it("admits exactly one of many concurrent mint-slot claims", async () => {
      await seed();
      // The defect the atomic claim exists to prevent: with a read-then-write
      // floor every one of these passes the same stale check and mints.
      const claims = await Promise.all(
        Array.from({ length: 8 }, () =>
          store.claimMintSlot(task, { orbId: orb.id, at: 10_000, minIntervalMs: 2_000 }),
        ),
      );
      const winners = claims.filter((claim) => claim._unsafeUnwrap().claimed);
      expect(winners.length).toBe(1);
      expect((await store.getOrb(task, orb.id))._unsafeUnwrap()?.lastMintAt).toBe(10_000);
    });

    it("lets a mint slot claim interleave a lifecycle read and its CAS", async () => {
      await seed();
      const before = (await store.getOrb(task, orb.id))._unsafeUnwrap();
      if (before === null) return;

      // A mint racing a stop is the schedule that matters: the claim lands
      // between the reconciler's read and its transition, and the transition
      // must still commit against the version it read.
      const claim = await store.claimMintSlot(task, {
        orbId: orb.id,
        at: 2_600,
        minIntervalMs: 2_000,
      });
      expect(claim._unsafeUnwrap()).toEqual({ claimed: true });

      const stopping = await store.casTransition(task, {
        orbId: orb.id,
        expectedStateVersion: before.stateVersion,
        toState: "stopping",
        now: 3_000,
      });
      expect(stopping.isOk() && stopping.value.state).toBe("stopping");
      expect(stopping.isOk() && stopping.value).toMatchObject({ lastMintAt: 2_600 });
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

    it("claims a mixed immutable FIFO backlog and blocks it during sleep", async () => {
      const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      (await store.insertProject(task, project))._unsafeUnwrap();
      (await store.insertOrb(task, { ...orb, state: "running" }))._unsafeUnwrap();
      for (const n of [201, 202])
        (await store.insertOrb(task, { ...orb, id: id(n) }))._unsafeUnwrap();
      const enqueue = async (n: number, peer?: number) =>
        (
          await store.enqueueOrbMessage(task, {
            orbId: orb.id,
            messageId: id(n),
            content: [{ type: "text", text: String(n) }],
            now: 2_000 + n,
            ...(peer === undefined
              ? {}
              : {
                  sender: {
                    orbId: id(peer),
                    projectId: project.id,
                    ownerUserId: OWNER,
                    caller: peerCentralCaller(id(peer)),
                  },
                }),
          })
        )._unsafeUnwrap();
      const claim = async (now = 3_000) =>
        (await store.claimOrbMessageBacklog(task, { orbId: orb.id, now }))._unsafeUnwrap();
      await enqueue(211);
      await enqueue(212);
      const prefix = (
        await store.claimNextOrbMessageBatch(task, { orbId: orb.id, now: 2_500 })
      )._unsafeUnwrap();
      await enqueue(213, 201);
      await enqueue(214, 202);
      await enqueue(215);
      await enqueue(216);
      const snapshot = await claim();
      expect(snapshot.map((r) => r.messageId)).toEqual([211, 212, 213, 214, 215, 216].map(id));
      expect(snapshot.map((r) => r.deliveryBatchId)).toEqual([
        prefix[0]!.deliveryBatchId,
        prefix[0]!.deliveryBatchId,
        id(213),
        id(214),
        messageBatchId([id(215), id(216)]),
        messageBatchId([id(215), id(216)]),
      ]);
      expect(snapshot.map((r) => r.system)).toEqual([
        null,
        null,
        { kind: "orb_message", senderOrbId: id(201) },
        { kind: "orb_message", senderOrbId: id(202) },
        null,
        null,
      ]);
      expect(snapshot.every((r) => r.status === "delivering")).toBe(true);
      expect(await claim(5_000)).toEqual(snapshot);
      await enqueue(217);
      const beforeSleep = (await store.listOrbMessages(task, orb.id))._unsafeUnwrap();
      const sleeping = (
        await store.scheduleOrbSleep(task, {
          orbId: orb.id,
          caller: peerCentralCaller(orb.id),
          sleepId: id(220),
          durationSeconds: 300,
        })
      )._unsafeUnwrap();
      expect(await claim(6_000)).toEqual([]);
      expect((await store.listOrbMessages(task, orb.id))._unsafeUnwrap()).toEqual(beforeSleep);
      (
        await store.cancelOrbSleep(task, {
          orbId: orb.id,
          expectedStateVersion: sleeping.stateVersion,
          now: 7_000,
        })
      )._unsafeUnwrap();
      const extended = await claim(8_000);
      expect(extended.slice(0, snapshot.length)).toEqual(snapshot);
      expect(extended.slice(snapshot.length).map((r) => r.deliveryBatchId)).toEqual([id(217)]);
      expect(await claim(9_000)).toEqual(extended);
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
      const batchId = batch._unsafeUnwrap()[0]?.deliveryBatchId;
      expect(batchId).toMatch(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
      expect(batchId).not.toBe(messageId);
      expect(batch._unsafeUnwrap().every((row) => row.deliveryBatchId === batchId)).toBe(true);

      const nativeRecord: HistoryRecord = {
        id: "inbox-record",
        parentId: null,
        timestamp: "2026-08-10T00:00:00.000Z",
        type: "message",
        role: "user",
        content,
        inboxMessageIds: [messageId, secondMessageId],
        overflow: {},
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
      const rows = messages._unsafeUnwrap();
      const firstOrdinal = rows[0]?.ordinal ?? 0;
      const selected = (
        await store.pollOrbMessages(task, orb.id, {
          afterOrdinal: firstOrdinal,
          trackedIds: [messageId],
        })
      )._unsafeUnwrap();
      expect(selected.items.map((row) => row.messageId)).toEqual([secondMessageId]);
      expect(selected.updates.map((row) => row.messageId)).toEqual([messageId]);
      expect(selected.updates[0]).not.toHaveProperty("content");
      expect(selected.updates[0]).not.toHaveProperty("system");
      const cursor = rows[1]?.ordinal ?? 0;
      expect(selected.cursor).toBe(cursor);
      expect(
        (
          await store.pollOrbMessages(task, orb.id, { afterOrdinal: cursor, trackedIds: [] })
        )._unsafeUnwrap(),
      ).toEqual({ items: [], updates: [], cursor });
      expect(
        (
          await store.pollOrbMessages(task, orb.id, {
            afterOrdinal: cursor,
            trackedIds: [messageId],
          })
        )
          ._unsafeUnwrap()
          .updates.map((row) => row.messageId),
      ).toEqual([messageId]);
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
            deliveryBatchId: rejectedId,
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
        (
          await store.requestOrbStop(task, {
            orbId: orb.id,
            expectedStateVersion: 5,
            now: 2_700,
          })
        ).isOk(),
      ).toBe(true);
      const notWoken = await store.casStartOrbForQueuedMessage(task, {
        orbId: orb.id,
        expectedStateVersion: 6,
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
        autoRestartTimes: [1_000, 1_500],
      });
      expect(failed.isOk() && failed.value.stateVersion).toBe(1);
      expect((await store.getOrb(task, orb.id))._unsafeUnwrap()?.autoRestartTimes).toEqual([
        1_000, 1_500,
      ]);
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
      // Human input renews the automatic-restart budget (docs/lifecycle.md).
      expect(woken.isOk() && woken.value?.autoRestartTimes).toEqual([]);

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
        inboxMessageIds: [messageId],
        overflow: {},
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
      const nativePayload = { message: { content: unicodeStrings, details: unicodeOverflow } };
      const native: HistoryRecord = {
        ...second,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: unicodeStrings.join("|") }],
        overflow: { native: nativePayload, other: "safe" },
      };
      const original = JSON.stringify([first, native]);
      const committed = await store.commitPullBatch(task, {
        orbId: orb.id,
        expectedCursor: null,
        session,
        records: [first, native],
        nextCursor: second.id,
        nextHeadId: second.id,
      });
      expect(committed.isOk() && committed.value.replicationCursor).toBe(second.id);

      const repeated = await store.commitPullBatch(task, {
        orbId: orb.id,
        expectedCursor: second.id,
        session,
        records: [first, { ...native, overflow: { other: "safe", native: nativePayload } }],
        nextCursor: second.id,
        nextHeadId: second.id,
      });
      expect(repeated.isOk()).toBe(true);

      const snapshot = await store.readHistorySnapshot(task, orb.id);
      expect(snapshot.isOk() && snapshot.value.records).toEqual([first, native]);
      expect(JSON.stringify([first, native])).toBe(original);
      expect(
        (await store.readHistoryRecord(task, orb.id, session.id, second.id))._unsafeUnwrap(),
      ).toEqual(native);
      expect(
        (await store.readHistoryRecord(task, orb.id, "wrong-session", second.id))._unsafeUnwrap(),
      ).toBeNull();
      expect(
        (await store.readHistoryRecord(task, orb.id, session.id, "missing"))._unsafeUnwrap(),
      ).toBeNull();
    });

    it("anchors source history to an inactive branch without changing replica metadata", async () => {
      await seed();
      const sibling = { ...second, id: "sibling", parentId: first.id };
      const latest = { ...first, id: "latest", parentId: sibling.id };
      expect(
        (
          await store.commitPullBatch(task, {
            orbId: orb.id,
            expectedCursor: null,
            session,
            records: [first, second, sibling, latest],
            nextCursor: latest.id,
            nextHeadId: sibling.id,
          })
        ).isOk(),
      ).toBe(true);
      const current = (await store.readHistorySnapshot(task, orb.id))._unsafeUnwrap();
      expect(current).toEqual({
        session,
        cursor: latest.id,
        headId: sibling.id,
        records: [first, sibling, latest],
      });
      expect((await store.readHistorySnapshot(task, orb.id, second.id))._unsafeUnwrap()).toEqual({
        ...current,
        records: [first, second],
      });
      expect((await store.readHistorySnapshot(task, orb.id, "missing"))._unsafeUnwrap()).toEqual({
        ...current,
        records: [],
      });
      expect((await store.readHistorySnapshot(task, orb.id))._unsafeUnwrap()).toEqual(current);
    });

    it.each(["pi", "claude"] as const)(
      "preserves %s snapshot semantics across null-parent compactions",
      async (harness) => {
        (await store.insertProject(task, project))._unsafeUnwrap();
        (await store.insertOrb(task, { ...orb, harness, state: "stopped" }))._unsafeUnwrap();
        const user = {
          ...first,
          timestamp: "2026-08-04T00:00:00.000Z",
          inboxMessageIds: ["00000000-0000-4000-8000-000000000055"],
        };
        const compact1: HistoryRecord = {
          id: "compact-1",
          parentId: null,
          timestamp: "2026-08-07T00:00:00.000Z",
          type: "event",
          eventType: "claude.compact_boundary",
          overflow: {},
        };
        const compact2 = { ...compact1, id: "compact-2", timestamp: "2026-08-08T00:00:00.000Z" };
        const child = {
          ...second,
          id: "backdated-child",
          parentId: compact1.id,
          timestamp: "2026-08-06T00:00:00.000Z",
        };
        const cursor = {
          ...second,
          id: "cursor",
          parentId: compact2.id,
          timestamp: "2026-08-05T00:00:00.000Z",
        };
        const records = [user, compact1, child, compact2, cursor];
        (
          await store.commitPullBatch(task, {
            orbId: orb.id,
            expectedCursor: null,
            session,
            records,
            nextCursor: cursor.id,
            nextHeadId: compact2.id,
          })
        )._unsafeUnwrap();
        const current = (await store.readHistorySnapshot(task, orb.id))._unsafeUnwrap();
        expect(current).toEqual({
          session,
          cursor: cursor.id,
          headId: compact2.id,
          records: harness === "claude" ? records : [compact2, cursor],
        });
        expect((await store.readHistorySnapshot(task, orb.id, child.id))._unsafeUnwrap()).toEqual({
          ...current,
          records: [compact1, child],
        });
      },
    );

    it("rejects cursor and immutable-record conflicts without partial advancement", async () => {
      await seed();
      const unicode: HistoryRecord = { ...first, overflow: { "\udfff": "\u0000\ud800" } };
      expect(
        (
          await store.commitPullBatch(task, {
            orbId: orb.id,
            expectedCursor: null,
            session,
            records: [unicode],
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

      const changed = { ...unicode, content: [{ type: "text" as const, text: "changed" }] };
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

    it("persists name and repository together and rejects edits after deletion", async () => {
      expect((await store.insertProject(task, project)).isOk()).toBe(true);
      const params = {
        projectId: project.id,
        name: "updated",
        repositoryUrl: "https://github.com/acme/new",
        now: 2000,
      };
      const saved = await store.updateProject(task, params);
      expect(saved.isOk() && saved.value).toMatchObject({
        name: params.name,
        repositoryUrl: params.repositoryUrl,
      });
      const persisted = await store.getProject(task, project.id);
      expect(persisted.isOk() && persisted.value).toMatchObject({
        name: params.name,
        repositoryUrl: params.repositoryUrl,
      });
      expect(
        (
          await store.requestProjectDeletion(task, {
            projectId: project.id,
            now: 3000,
            cleanupAfter: 3000,
          })
        ).isOk(),
      ).toBe(true);
      const createRetry = await store.insertProject(task, saved._unsafeUnwrap() ?? project);
      expect(
        createRetry.isErr() &&
          createRetry.error.type === "project_conflict" &&
          createRetry.error.reason,
      ).toBe("concurrent_change");
      const late = await store.updateProject(task, {
        ...params,
        name: "too late",
        repositoryUrl: "https://github.com/acme/late",
      });
      expect(late.isOk() && late.value === null).toBe(true);
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

    it.each([
      { runtimeTokenHash: "stale", hostIncarnation: 2 },
      { runtimeTokenHash: "current", hostIncarnation: 1 },
    ])("fences self-delete authority inside the write: %j", async (caller) => {
      expect((await store.insertProject(task, project)).isOk()).toBe(true);
      expect(
        (
          await store.insertOrb(task, {
            ...orb,
            state: "running",
            runtimeTokenHash: "current",
            hostIncarnation: 2,
          })
        ).isOk(),
      ).toBe(true);
      const request = { orbId: orb.id, expectedStateVersion: 0, now: 2_000, cleanupAfter: 3_000 };
      const rejected = await store.requestOrbDeletion(task, { ...request, caller });
      expect(rejected.isErr() && rejected.error.type).toBe("state_conflict");
      expect((await store.getOrbDeletion(task, orb.id))._unsafeUnwrap()).toBeNull();
      const accepted = await store.requestOrbDeletion(task, {
        ...request,
        caller: { runtimeTokenHash: "current", hostIncarnation: 2 },
      });
      expect(accepted.isOk() && accepted.value.state).toBe("deleting");
    });

    it.each(["stopping", "discard"])(
      "refuses self-delete at the write during %s",
      async (condition) => {
        expect((await store.insertProject(task, project)).isOk()).toBe(true);
        expect(
          (
            await store.insertOrb(task, {
              ...orb,
              state: condition === "stopping" ? "stopping" : "running",
              runtimeTokenHash: "current",
              hostDiscardThroughIncarnation: condition === "discard" ? 0 : null,
              hostDiscardReason: condition === "discard" ? "failed" : null,
              hostDiscardRequestedAt: condition === "discard" ? 1_000 : null,
            })
          ).isOk(),
        ).toBe(true);
        const rejected = await store.requestOrbDeletion(task, {
          orbId: orb.id,
          expectedStateVersion: 0,
          now: 2_000,
          cleanupAfter: 3_000,
          caller: { runtimeTokenHash: "current", hostIncarnation: orb.hostIncarnation },
        });
        expect(rejected.isErr() && rejected.error.type).toBe("state_conflict");
        expect((await store.getOrbDeletion(task, orb.id))._unsafeUnwrap()).toBeNull();
      },
    );

    it.each([
      { runtimeTokenHash: "stale", hostIncarnation: 2 },
      { runtimeTokenHash: "current", hostIncarnation: 1 },
    ])("fences self-archive authority inside the write: %j", async (caller) => {
      expect((await store.insertProject(task, project)).isOk()).toBe(true);
      expect(
        (
          await store.insertOrb(task, {
            ...orb,
            state: "running",
            runtimeTokenHash: "current",
            hostIncarnation: 2,
          })
        ).isOk(),
      ).toBe(true);
      const request = { orbId: orb.id, expectedStateVersion: 0, now: 2_000, cleanupAfter: 3_000 };
      const rejected = await store.requestOrbArchive(task, { ...request, caller });
      expect(rejected.isErr() && rejected.error.type).toBe("state_conflict");
      expect((await store.getOrbDeletion(task, orb.id))._unsafeUnwrap()).toBeNull();
      const accepted = await store.requestOrbArchive(task, {
        ...request,
        caller: { runtimeTokenHash: "current", hostIncarnation: 2 },
      });
      expect(accepted.isOk() && accepted.value.state).toBe("archiving");
    });

    it.each(["stopping", "discard"])(
      "refuses self-archive at the write during %s",
      async (condition) => {
        expect((await store.insertProject(task, project)).isOk()).toBe(true);
        expect(
          (
            await store.insertOrb(task, {
              ...orb,
              state: condition === "stopping" ? "stopping" : "running",
              runtimeTokenHash: "current",
              hostDiscardThroughIncarnation: condition === "discard" ? 0 : null,
              hostDiscardReason: condition === "discard" ? "failed" : null,
              hostDiscardRequestedAt: condition === "discard" ? 1_000 : null,
            })
          ).isOk(),
        ).toBe(true);
        const rejected = await store.requestOrbArchive(task, {
          orbId: orb.id,
          expectedStateVersion: 0,
          now: 2_000,
          cleanupAfter: 3_000,
          caller: { runtimeTokenHash: "current", hostIncarnation: orb.hostIncarnation },
        });
        expect(rejected.isErr() && rejected.error.type).toBe("state_conflict");
        expect((await store.getOrbDeletion(task, orb.id))._unsafeUnwrap()).toBeNull();
      },
    );

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

    /**
     * Migration 011's `oidc_signing_keys_timestamps_complete`. These three
     * transitions are not races a caller retries into — they are rows the
     * schema will not hold, so both drivers must refuse them as `corruption`
     * and leave the row untouched. `rotateSigningKey`'s convergence loop
     * depends on the last of them being impossible: a retired key can never be
     * CASed back into signing.
     */
    it("refuses transitions the timestamp completeness check forbids", async () => {
      expect((await keys.insertSigningKey(task, pending("kid-a", 1_000))).isOk()).toBe(true);

      // Activation must record when the key started signing: `activated_at` is
      // how the overlap window is reconstructed afterwards.
      const undated = await keys.casSigningKeyState(task, {
        kid: "kid-a",
        expectedRowVersion: 0,
        state: "active",
      });
      expect(undated.isErr() && undated.error.type).toBe("store_error");
      expect(undated.isErr() && undated.error.type === "store_error" && undated.error.code).toBe(
        "corruption",
      );

      // Retiring a key that never signed would claim an overlap window for a
      // key no live token can name.
      const neverActive = await keys.casSigningKeyState(task, {
        kid: "kid-a",
        expectedRowVersion: 0,
        state: "retired",
        retiredAt: 2_000,
      });
      expect(neverActive.isErr() && neverActive.error.type).toBe("store_error");
      expect(
        neverActive.isErr() && neverActive.error.type === "store_error" && neverActive.error.code,
      ).toBe("corruption");

      // Neither refusal wrote: the row is still the pending one it started as.
      const untouched = await keys.listSigningKeys(task);
      expect(untouched.isOk() && untouched.value[0]).toEqual(pending("kid-a", 1_000));

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
      expect(
        (
          await keys.casSigningKeyState(task, {
            kid: "kid-a",
            expectedRowVersion: 1,
            state: "retired",
            retiredAt: 4_000,
          })
        ).isOk(),
      ).toBe(true);

      // Resurrection: a retired row CASed back to `active` keeps its
      // `retired_at`, which the check forbids. Nothing may un-retire a key.
      const resurrected = await keys.casSigningKeyState(task, {
        kid: "kid-a",
        expectedRowVersion: 2,
        state: "active",
        activatedAt: 5_000,
      });
      expect(resurrected.isErr() && resurrected.error.type).toBe("store_error");
      expect(
        resurrected.isErr() && resurrected.error.type === "store_error" && resurrected.error.code,
      ).toBe("corruption");
      const listed = await keys.listSigningKeys(task);
      expect(listed.isOk() && listed.value[0]).toMatchObject({
        state: "retired",
        activatedAt: 3_000,
        retiredAt: 4_000,
        rowVersion: 2,
      });
    });

    it("refuses an inserted row whose timestamps do not match its state", async () => {
      // The boot path inserts directly as `active`, so the insert has to carry
      // an activation time; a `pending` row carrying one is equally refused.
      const undated = await keys.insertSigningKey(task, {
        ...pending("kid-a", 1_000),
        state: "active",
      });
      expect(undated.isErr() && undated.error.code).toBe("corruption");
      const predated = await keys.insertSigningKey(task, {
        ...pending("kid-b", 1_000),
        activatedAt: 1_000,
      });
      expect(predated.isErr() && predated.error.code).toBe("corruption");
      const listed = await keys.listSigningKeys(task);
      expect(listed.isOk() && listed.value).toEqual([]);
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
 * credential and project-secret pointer stores.
 */
export function storeContractTests(name: string, open: () => Promise<StoreContractSubject>): void {
  storeSemanticsContractTests(name, async () => {
    const subject = await open();
    const migrated = await subject.database.migrate();
    expect(migrated.isOk()).toBe(true);
    expect(
      (
        await subject.database.users.resolveUser(
          task,
          { issuer: "store-contract", subject: name, email: null },
          { id: OWNER, now: 0 },
        )
      ).isOk(),
    ).toBe(true);
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
    let projectSecrets: ProjectSecretPointerStore;

    beforeEach(async () => {
      const subject = await open();
      database = subject.database;
      client = subject.client;
      const migrated = await database.migrate();
      expect(migrated.isOk()).toBe(true);
      expect(
        (
          await database.users.resolveUser(
            task,
            { issuer: "driver-contract", subject: name, email: null },
            { id: OWNER, now: 0 },
          )
        ).isOk(),
      ).toBe(true);
      store = database.store;
      pointers = database.pointers.forUser(OWNER);
      projectSecrets = database.projectSecrets;
    });

    afterEach(async () => {
      expect((await database.close()).isOk()).toBe(true);
    });

    it("isolates credential pointer CAS and leases by user", async () => {
      const otherOwner = "00000000-0000-4000-8000-000000000002";
      expect(
        (
          await database.users.resolveUser(
            task,
            { issuer: "driver-contract", subject: `${name}-other`, email: null },
            { id: otherOwner, now: 0 },
          )
        ).isOk(),
      ).toBe(true);
      const alice = database.pointers.forUser(OWNER);
      const bob = database.pointers.forUser(otherOwner);
      expect(
        (
          await alice.casWritePointer(task, "openai-codex", null, {
            generation: 4,
            secretVersion: "alice-v4",
            refreshLeaseUntil: 111,
            lastRefreshAt: 10,
          })
        ).isOk(),
      ).toBe(true);
      expect(
        (
          await bob.casWritePointer(task, "openai-codex", null, {
            generation: 9,
            secretVersion: "bob-v9",
            refreshLeaseUntil: 222,
            lastRefreshAt: 20,
          })
        ).isOk(),
      ).toBe(true);
      expect((await alice.readPointer(task, "openai-codex"))._unsafeUnwrap()).toMatchObject({
        generation: 4,
        secretVersion: "alice-v4",
        refreshLeaseUntil: 111,
      });
      expect((await bob.readPointer(task, "openai-codex"))._unsafeUnwrap()).toMatchObject({
        generation: 9,
        secretVersion: "bob-v9",
        refreshLeaseUntil: 222,
      });
    });

    async function seed(): Promise<void> {
      expect((await store.insertProject(task, project)).isOk()).toBe(true);
      expect((await store.insertOrb(task, orb)).isOk()).toBe(true);
    }

    it("rejects foreign-owner cross-project sends and retries", async () => {
      await seed();
      const ownerUserId = "00000000-0000-4000-8000-000000000098";
      (
        await database.users.resolveUser(
          task,
          { issuer: "driver-contract", subject: `${name}-peer-owner`, email: null },
          { id: ownerUserId, now: 0 },
        )
      )._unsafeUnwrap();
      const targetProject = { ...project, id: "00000000-0000-4000-8000-000000000010", ownerUserId };
      (await store.insertProject(task, targetProject))._unsafeUnwrap();
      const target = {
        ...orb,
        id: "00000000-0000-4000-8000-000000000003",
        projectId: targetProject.id,
      };
      (await store.insertOrb(task, target))._unsafeUnwrap();
      const params = {
        orbId: target.id,
        messageId: "00000000-0000-4000-8000-000000000004",
        content: [{ type: "text" as const, text: "peer" }],
        now: 2000,
        sender: {
          orbId: orb.id,
          projectId: project.id,
          ownerUserId: OWNER,
          caller: {
            kind: "central" as const,
            ownerUserId: OWNER,
            projectId: project.id,
            orbId: orb.id,
            agentAdmissionVersion: 0,
          },
        },
      };
      expect((await store.enqueueOrbMessage(task, params)).isErr()).toBe(true);
      expect((await store.enqueueOrbMessage(task, params)).isErr()).toBe(true);
      expect((await store.listOrbMessages(task, target.id))._unsafeUnwrap()).toHaveLength(0);
    });

    it("enforces exact sleep/peer metadata shapes including SQL NULL fields", async () => {
      await seed();
      let ordinal = 10;
      for (const system of [
        null,
        { kind: "sleep_wake", sleepUntil: "deadline" },
        { kind: "sleep_expired", sleepUntil: "deadline" },
        { kind: "orb_message", senderOrbId: orb.id },
        {},
        { kind: null },
        { kind: "orb_message" },
        { kind: "orb_message", senderOrbId: null },
        { kind: "orb_message", senderOrbId: "bad" },
        { kind: "orb_message", senderOrbId: 1 },
        { kind: "orb_message", senderOrbId: orb.id, extra: true },
        { kind: "sleep_wake", sleepUntil: null },
        { kind: "sleep_wake" },
        { kind: "unknown", sleepUntil: "deadline" },
        { kind: null, sleepUntil: "x" },
        { kind: "sleep_wake", sleepUntil: "x", extra: true },
      ]) {
        const valid = ordinal < 14;
        const result = await client.query(
          `INSERT INTO orb_messages
          (orb_id, message_id, content, system, created_at, updated_at)
          VALUES ($1,$2,$3::jsonb,$4::jsonb,now(),now())`,
          [
            orb.id,
            `00000000-0000-4000-8000-0000000000${ordinal++}`,
            jsonParam([{ type: "text", text: "peer" }]),
            jsonParam(system),
          ],
        );
        expect(result.isOk(), JSON.stringify(system)).toBe(valid);
      }
    });

    it
      .skipIf(!name.startsWith("node-postgres"))
      .each(["session", "source", "orb", "project"] as const)(
      "serializes headline publication behind an uncommitted %s fence on real PostgreSQL",
      async (fence) => {
        await seed();
        (
          await store.commitPullBatch(task, {
            orbId: orb.id,
            expectedCursor: null,
            session,
            records: [first],
            nextCursor: first.id,
            nextHeadId: first.id,
          })
        )._unsafeUnwrap();
        const value = {
          orbId: orb.id,
          sessionId: session.id,
          recordId: first.id,
          detailKey: "detail",
          headline: "Candidate",
          generatedAt: 1234,
        };
        if (fence === "source")
          (
            await client.query(
              "UPDATE orbs SET replication_cursor = NULL, replicated_head_id = NULL WHERE id = $1",
              [orb.id],
            )
          )._unsafeUnwrap();
        let entered!: () => void;
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const mutation = client.transaction(async (query) => {
          const sql =
            fence === "project"
              ? "UPDATE projects SET state = 'deleting' WHERE id = $1"
              : fence === "orb"
                ? "UPDATE orbs SET state = 'deleting' WHERE id = $1"
                : fence === "session"
                  ? 'UPDATE orbs SET harness_session_id = \'changed\', harness_session_header = \'{"id":"changed","overflow":{}}\' WHERE id = $1'
                  : "DELETE FROM history_records WHERE orb_id = $1";
          const changed = await query(sql, [fence === "project" ? project.id : orb.id]);
          entered();
          await gate;
          return changed;
        });
        await held;
        const publication = store.putActivityHeadlineIfAbsent(task, value);
        try {
          let blocked = false;
          for (let probe = 0; probe < 200 && !blocked; probe++) {
            const locks = (
              await client.query(
                "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE '%headline%'",
              )
            )._unsafeUnwrap();
            blocked = locks.rows.length > 0;
          }
          expect(blocked, "publication must wait for the uncommitted fence").toBe(true);
        } finally {
          release();
        }
        (await mutation)._unsafeUnwrap();
        expect((await publication)._unsafeUnwrap()).toBeNull();
        expect(
          (await store.readActivityHeadlines(task, orb.id, session.id))._unsafeUnwrap(),
        ).toEqual([]);
      },
    );

    it("cascades headline source/session deletion and fences subsequent publication", async () => {
      await seed();
      (
        await store.commitPullBatch(task, {
          orbId: orb.id,
          expectedCursor: null,
          session,
          records: [first],
          nextCursor: first.id,
          nextHeadId: first.id,
        })
      )._unsafeUnwrap();
      const value = {
        orbId: orb.id,
        sessionId: session.id,
        recordId: first.id,
        detailKey: "detail",
        headline: "Original",
        generatedAt: 1234,
      };
      (await store.putActivityHeadlineIfAbsent(task, value))._unsafeUnwrap();
      (
        await client.transaction(async (query) => {
          const cleared = await query(
            "UPDATE orbs SET replication_cursor = NULL, replicated_head_id = NULL WHERE id = $1",
            [orb.id],
          );
          if (cleared.isErr()) return err(cleared.error);
          return query("DELETE FROM history_records WHERE orb_id = $1", [orb.id]);
        })
      )._unsafeUnwrap();
      expect((await store.readActivityHeadline(task, value))._unsafeUnwrap()).toBeNull();
      expect((await store.putActivityHeadlineIfAbsent(task, value))._unsafeUnwrap()).toBeNull();
      (
        await store.commitPullBatch(task, {
          orbId: orb.id,
          expectedCursor: null,
          session,
          records: [first],
          nextCursor: first.id,
          nextHeadId: first.id,
        })
      )._unsafeUnwrap();
      (await store.putActivityHeadlineIfAbsent(task, value))._unsafeUnwrap();
      (
        await client.query(
          "UPDATE orbs SET replication_cursor = NULL, replicated_head_id = NULL WHERE id = $1",
          [orb.id],
        )
      )._unsafeUnwrap();
      (
        await store.initOrVerifySession(task, orb.id, { id: "new-session", overflow: {} })
      )._unsafeUnwrap();
      expect((await store.readActivityHeadline(task, value))._unsafeUnwrap()).toBeNull();
      expect((await store.putActivityHeadlineIfAbsent(task, value))._unsafeUnwrap()).toBeNull();
      expect(
        (
          await store.putActivityHeadlineIfAbsent(task, { ...value, sessionId: "new-session" })
        )._unsafeUnwrap(),
      ).not.toBeNull();
      (
        await client.query("UPDATE projects SET state = 'deleting' WHERE id = $1", [project.id])
      )._unsafeUnwrap();
      expect(
        (
          await store.putActivityHeadlineIfAbsent(task, { ...value, sessionId: "new-session" })
        )._unsafeUnwrap(),
      ).toBeNull();
    });

    it("rolls back partial spawn writes and retains deletion-safe provenance", async () => {
      await seed();
      expect(
        (
          await client.query(
            "UPDATE orbs SET state = 'running', runtime_token_hash = 'token' WHERE id = $1",
            [orb.id],
          )
        ).isOk(),
      ).toBe(true);
      const child = { ...orb, id: "00000000-0000-4000-8000-000000000003" };
      const params = {
        callerOrbId: orb.id,
        caller: { runtimeTokenHash: "token", hostIncarnation: 0 },
        orb: child,
        prompt: "work",
        requestHash: "hash",
      };
      // Fail the last write, after both the child and its message were inserted.
      expect(
        (
          await client.query("ALTER TABLE orb_spawns ADD CONSTRAINT reject_spawn CHECK (false)")
        ).isOk(),
      ).toBe(true);
      expect((await store.spawnOrb(task, params)).isErr()).toBe(true);
      expect((await store.getOrb(task, child.id))._unsafeUnwrap()).toBeNull();
      expect((await store.listOrbMessages(task, child.id))._unsafeUnwrap()).toEqual([]);
      expect(
        (await client.query("ALTER TABLE orb_spawns DROP CONSTRAINT reject_spawn")).isOk(),
      ).toBe(true);
      expect((await store.spawnOrb(task, params)).isOk()).toBe(true);
      const provenance = (
        await client.query(
          "SELECT caller_orb_id, caller_incarnation, request_hash FROM orb_spawns WHERE orb_id = $1",
          [child.id],
        )
      )._unsafeUnwrap().rows[0];
      expect(provenance?.["caller_orb_id"]).toBe(orb.id);
      expect(provenance?.["request_hash"]).toBe("hash");
      expect((await client.query("DELETE FROM orbs WHERE id = $1", [child.id])).isOk()).toBe(true);
      expect((await store.spawnOrb(task, params)).isErr()).toBe(true);
      expect((await store.getOrb(task, child.id))._unsafeUnwrap()).toBeNull();
      expect((await client.query("DELETE FROM orbs WHERE id = $1", [orb.id])).isOk()).toBe(true);
      expect((await store.getSpawnCaller(task, child.id))._unsafeUnwrap()).toBe(orb.id);
      expect((await client.query("SELECT * FROM orb_spawns"))._unsafeUnwrap().rows).toHaveLength(1);
      expect((await client.query("DELETE FROM projects WHERE id = $1", [project.id])).isOk()).toBe(
        true,
      );
      expect((await client.query("SELECT * FROM orb_spawns"))._unsafeUnwrap().rows).toHaveLength(0);
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
      const header = { ...session, overflow: unicodeOverflow };
      (await store.initOrVerifySession(task, orb.id, header))._unsafeUnwrap();
      const committed = (
        await store.commitPullBatch(task, {
          orbId: orb.id,
          expectedCursor: null,
          session: header,
          records: [first],
          nextCursor: first.id,
          nextHeadId: first.id,
        })
      )._unsafeUnwrap();
      expect(committed.harnessSessionHeader).toEqual(header);
      expect((await store.getOrb(task, orb.id))._unsafeUnwrap()?.harnessSessionHeader).toEqual(
        header,
      );
      expect((await store.readHistorySnapshot(task, orb.id))._unsafeUnwrap()).toEqual({
        session: header,
        cursor: first.id,
        headId: first.id,
        records: [first],
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
      const inTransaction = await client.transaction<void, StoreError>(async (query) => {
        const guarded = await query("SELECT $1::jsonb AS value", [[1, 2]]);
        return guarded.isErr() ? err(guarded.error) : ok(undefined);
      });
      expect(inTransaction.isErr() && inTransaction.error.code).toBe("invariant");
      // A genuine SQL/schema mistake classifies the same way.
      const missingColumn = await client.query("SELECT no_such_column FROM orbs");
      expect(missingColumn.isErr() && missingColumn.error.code).toBe("invariant");
    });

    it("implements project-secret pointer CAS and the deletion fence", async () => {
      expect((await store.insertProject(task, project)).isOk()).toBe(true);
      const inserted = await projectSecrets.casWriteSecretPointer(task, project.id, null, {
        revision: 1,
        entries: { NPM_TOKEN: 2_000 },
        secretVersion: "v1",
        updatedAt: 2_000,
      });
      expect(inserted.isOk() && inserted.value).toMatchObject({
        rowVersion: 1,
        revision: 1,
        entries: { NPM_TOKEN: 2_000 },
        secretVersion: "v1",
      });
      const stale = await projectSecrets.casWriteSecretPointer(task, project.id, null, {
        revision: 2,
        entries: { NPM_TOKEN: 3_000 },
        secretVersion: "v2",
        updatedAt: 3_000,
      });
      expect(stale.isErr() && stale.error.type).toBe("project_secret_pointer_conflict");
      const deleting = await store.requestProjectDeletion(task, {
        projectId: project.id,
        now: 4_000,
        cleanupAfter: 5_000,
      });
      expect(deleting.isOk()).toBe(true);
      const readFenced = await projectSecrets.readSecretPointer(task, project.id);
      expect(readFenced.isErr() && readFenced.error.type).toBe("project_conflict");
      expect((await projectSecrets.deleteProjectSecretPointer(task, project.id)).isOk()).toBe(true);
    });

    it("implements user-secret pointer CAS", async () => {
      const write = (revision: number) => ({
        revision,
        entries: {},
        secretVersion: `v${revision}`,
        updatedAt: revision,
      });
      const secrets = database.ownerSecrets;
      expect((await secrets.readSecretPointer(task, OWNER))._unsafeUnwrap()).toBeNull();
      expect((await secrets.casWriteSecretPointer(task, OWNER, null, write(1))).isOk()).toBe(true);
      const stale = await secrets.casWriteSecretPointer(task, OWNER, null, write(2));
      expect(stale._unsafeUnwrapErr().type).toBe("project_secret_pointer_conflict");
      const updated = (
        await secrets.casWriteSecretPointer(task, OWNER, 1, write(2))
      )._unsafeUnwrap();
      expect(updated).toMatchObject({ rowVersion: 2, revision: 2, secretVersion: "v2" });
      expect((await secrets.readSecretPointer(task, OWNER))._unsafeUnwrap()).toEqual(updated);
    });

    it("serializes owner skill commands per user: renames and the count cap", async () => {
      const skills = database.ownerSkills;
      const other = new PostgreSQLOwnerSkillStore(client);
      const skill = (name: string) => ({
        name,
        content: `---\nname: ${name}\ndescription: d\n---\n`,
      });
      const create = (store: OwnerSkillStore, name: string) =>
        store.apply(task, OWNER, { kind: "create", skill: skill(name) });
      const names = async (result: ResultAsync<Array<{ name: string }>, unknown>) =>
        (await result)._unsafeUnwrap().map((record) => record.name);
      expect(await names(create(skills, "b"))).toEqual(["b"]);
      expect(await names(create(skills, "a"))).toEqual(["a", "b"]);
      // A concurrent rename and create of the same name: exactly one wins.
      const [renamed, created] = await Promise.all([
        skills.apply(task, OWNER, { kind: "replace", name: "b", skill: skill("c") }),
        create(other, "c"),
      ]);
      expect(renamed.isOk()).not.toBe(created.isOk());
      expect(await names(skills.list(task, OWNER))).toEqual(
        renamed.isOk() ? ["a", "c"] : ["a", "b", "c"],
      );
      const room = OWNER_SKILL_MAX_COUNT - (await names(skills.list(task, OWNER))).length;
      for (let i = 0; i < room - 2; i++) (await create(skills, `s-${i}`))._unsafeUnwrap();
      const racing = await Promise.all(
        ["w", "x", "y", "z"].map((name, i) => create(i % 2 ? other : skills, name)),
      );
      expect(racing.filter((result) => result.isOk())).toHaveLength(2);
      expect(await names(skills.list(task, OWNER))).toHaveLength(OWNER_SKILL_MAX_COUNT);
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

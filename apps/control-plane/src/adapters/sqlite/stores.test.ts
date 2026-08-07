import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessSessionMetadata, HistoryRecord } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OrbRow, ProjectRow } from "../../domain/orb.ts";
import { SqliteControlPlaneStore, SqliteCredentialPointerStore, SqliteDatabase } from "./stores.ts";

const task = new NoSimulationTask("sqlite test", false);
const project: ProjectRow = {
  id: "project-1",
  name: "project",
  repositoryUrl: "https://github.com/o/r",
  createdAt: 1_000,
};
const orb: OrbRow = {
  id: "orb-1",
  projectId: project.id,
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

let directory = "";
let database: SqliteDatabase;
let store: SqliteControlPlaneStore;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "pi-orb-sqlite-"));
  const opened = SqliteDatabase.open(join(directory, "control.sqlite"));
  expect(opened.isOk()).toBe(true);
  if (opened.isErr()) throw new Error(opened.error.message);
  database = opened.value;
  const migrated = database.migrate();
  expect(migrated.isOk()).toBe(true);
  store = new SqliteControlPlaneStore(database);
});

afterEach(() => {
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

async function seed(): Promise<void> {
  expect((await store.insertProject(task, project)).isOk()).toBe(true);
  expect((await store.insertOrb(task, orb)).isOk()).toBe(true);
}

describe("SQLite stores", () => {
  it("persists projects and performs lifecycle state-version CAS", async () => {
    await seed();
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

  it("implements credential pointer CAS", async () => {
    const pointers = new SqliteCredentialPointerStore(database);
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

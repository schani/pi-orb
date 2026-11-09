import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type ConversationId,
  createRegistry,
  defineDoc,
  type EntryId,
  type EntryRecord,
  Harness,
  type Storage,
  type StorageWrite,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import { NoSimulationTask } from "determined";
import { expect, it } from "vitest";
import { makeOrbRow, makeProjectRow, seedTestUser } from "../../testkit/fixtures.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { initializeBareAuthority } from "../durable-pg/bare-authority.testkit.ts";
import { PgDurableAuthority } from "../durable-pg/index.ts";
import { PGliteClient } from "../pg/pglite-client.ts";
import { projectNativeCommit } from "./atomic-history.ts";

it("commits native root history and public projection without a loaded agent", async () => {
  const db = new PGliteClient();
  const database = composeControlPlaneDatabase(db);
  const task = new NoSimulationTask("atomic-native", false);
  const project = makeProjectRow(randomUUID());
  const orb = makeOrbRow(randomUUID(), project.id, "running");
  let harness: Harness | undefined;
  try {
    (await database.migrate())._unsafeUnwrap();
    (await seedTestUser(task, database.users))._unsafeUnwrap();
    (await database.store.insertProject(task, project))._unsafeUnwrap();
    (await database.store.insertOrb(task, orb))._unsafeUnwrap();
    const authority = new PgDurableAuthority(db, () => 0);
    const owner = (await authority.acquire(orb.id, "owner", 0, 0, 100))._unsafeUnwrap();
    const storage = (
      await authority.open(owner, {
        project: (query, writes) => projectNativeCommit(query, orb.id, writes),
      })
    )._unsafeUnwrap();
    harness = await Harness.open(
      storage,
      { models: createModels(), registry: createRegistry() },
      context,
    );
    const root = await harness.root(context);
    const identity = defineDoc({
      kind: "orb.identity",
      version: 1,
      checkpointWhen: () => false,
      scope: "conversation",
      history: "latest",
      fork: "initial",
      initial: () => ({ sessionId: "native", timestamp: 0, receipts: {} }),
    });
    await root.commit(async (tx) => {
      await tx.doc(identity, root.id);
      await tx.appendEntry(root.id, {
        kind: "pi.message",
        model: [{ role: "user", content: "atomic text", timestamp: 1 }],
      });
    }, context);
    const row = (await database.store.getOrb(task, orb.id))._unsafeUnwrap();
    expect(row?.harnessSessionId).toBe("native");
    const records = (
      await db.query("SELECT record FROM history_records WHERE orb_id=$1", [orb.id])
    )._unsafeUnwrap();
    expect(JSON.stringify(records.rows)).toContain("atomic text");
    expect(row?.replicationCursor).not.toBeNull();
  } finally {
    if (harness) await harness.close(context);
    await database.close();
  }
});

it("projects complete grouped batches in source order, retains accepted prefixes, and rolls back invalid publication", async () => {
  const db = new PGliteClient();
  const orbId = randomUUID();
  const { database, task } = await initializeBareAuthority(db, orbId);
  let harness: Harness | undefined;
  let storage: Storage | undefined;
  const authority = new PgDurableAuthority(db, () => 0);
  try {
    const owner = (await authority.acquire(orbId, "owner", 0, 0, 100))._unsafeUnwrap();
    const openStorage = async () =>
      (
        await authority.open(owner, {
          project: (query, writes, _seq, admitted) =>
            projectNativeCommit(query, orbId, writes, admitted),
        })
      )._unsafeUnwrap();
    storage = await openStorage();
    harness = await Harness.open(
      storage,
      { models: createModels(), registry: createRegistry() },
      context,
    );
    const root = await harness.root(context);
    const older = await storage.mintId<EntryId>();
    const wakeId = randomUUID(),
      humanId = randomUUID();
    const receipts = {
      wake: { messageIds: [wakeId], system: { kind: "sleep_wake", sleepUntil: "t" } },
      human: { messageIds: [humanId] },
    };
    const identity = defineDoc({
      kind: "orb.identity",
      version: 1,
      checkpointWhen: () => false,
      scope: "conversation",
      history: "latest",
      fork: "initial",
      initial: () => ({ sessionId: "native", timestamp: 0, receipts }),
    });
    let privateId!: EntryId;
    await root.commit(async (tx) => {
      await tx.doc(identity, root.id);
      privateId = (await tx.appendEntry(root.id, { kind: "pi.system" })).id;
      await tx.appendEntry(root.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "prefix", timestamp: 1 }],
      });
    }, context);
    const prefix = (await database.store.getOrb(task, orbId))._unsafeUnwrap()?.replicationCursor;
    await harness.close(context);
    harness = undefined;
    storage = await openStorage();
    const ownedStorage = storage;
    const entry = async (content: string, kind = "pi.user"): Promise<EntryRecord> => ({
      id: await ownedStorage.mintId<EntryId>(),
      conversationId: root.id,
      kind,
      model: [{ role: "user", content, timestamp: 2 }],
    });
    const human = await entry("human"),
      gap = await entry("private", "pi.reset"),
      wake = await entry("wake"),
      notice = await entry(
        JSON.stringify({ agent_id: "7", description: "task", message: "notice" }),
      );
    const childId = await storage.mintId<ConversationId>();
    const child = { ...(await entry("private child")), conversationId: childId };
    const submission = async (source: EntryRecord, requestId: string): Promise<StorageWrite> => ({
      type: "submission",
      value: {
        id: await ownedStorage.mintId<SubmissionId>(),
        conversationId: root.id,
        type: "input",
        status: "placed",
        entry: source.id,
        requestId,
      },
    });
    const batches: StorageWrite[][] = [
      [
        { type: "conversation", value: { id: childId } },
        { type: "entry", value: child },
        { type: "entry", value: gap },
        await submission(human, "inbox:human"),
        { type: "entry", value: human },
      ],
      [
        { type: "entry", value: notice },
        await submission(notice, "subagent-notify:7:test"),
        await submission(wake, "inbox:wake"),
        { type: "entry", value: wake },
      ],
      [{ type: "entry", value: human }],
      [{ type: "entry", value: await entry("not reached") }],
    ];
    const received: number[] = [];
    const committed = await storage.commit(batches, (index) => received.push(index), context);
    expect(committed).toMatchObject({ stored: 2, refused: expect.any(Error) });
    expect(received).toEqual([0, 1]);
    const publicRows = (
      await db.query("SELECT record FROM history_records WHERE orb_id=$1 ORDER BY record_id", [
        orbId,
      ])
    )._unsafeUnwrap().rows;
    const records = publicRows
      .map((row) => row.record as { id: string; parentId: string | null })
      .sort((a, b) => Number(a.id.split(":").at(-1)) - Number(b.id.split(":").at(-1)));
    expect(records.map(({ id, parentId }) => ({ id, parentId }))).toEqual([
      { id: prefix, parentId: null },
      { id: `native:${human.id}`, parentId: prefix },
      { id: `native:${wake.id}`, parentId: `native:${human.id}` },
      { id: `native:${notice.id}`, parentId: `native:${wake.id}` },
    ]);
    expect(records[1]).toMatchObject({
      type: "message",
      inboxMessageIds: [humanId],
      content: [{ type: "text", text: "human" }],
    });
    expect(records[2]).toEqual({
      id: `native:${wake.id}`,
      parentId: `native:${human.id}`,
      timestamp: new Date(2).toISOString(),
      type: "event",
      eventType: "pi.custom_message",
      custom: { customType: "pi-orb.sleep-wake", display: true },
      content: [{ type: "text", text: "wake" }],
      inboxMessageIds: [wakeId],
      overflow: {},
    });
    expect(records[3]).toEqual({
      id: `native:${notice.id}`,
      parentId: `native:${wake.id}`,
      timestamp: new Date(2).toISOString(),
      type: "event",
      eventType: "pi.custom_message",
      custom: { customType: "subagent-notification", display: true },
      subagent: { kind: "notification", id: "7", description: "task", message: "notice" },
      overflow: {},
    });
    const cursor = `native:${notice.id}`;
    const good = await entry("rolled back"),
      invalid = await entry("not JSON");
    await expect(
      storage.commit(
        [
          [{ type: "entry", value: good }],
          [
            { type: "entry", value: invalid },
            await submission(invalid, "subagent-notify:7:invalid"),
          ],
        ],
        () => received.push(99),
        context,
      ),
    ).rejects.toMatchObject({
      cause: { code: "projection", message: "Native history mapping failed" },
    });
    expect(received).toEqual([0, 1]);
    expect(await storage.entry(good.id, context)).toBeUndefined();
    expect(await storage.entry(invalid.id, context)).toBeUndefined();
    expect((await database.store.getOrb(task, orbId))._unsafeUnwrap()?.replicationCursor).toBe(
      cursor,
    );
    const badCursors = ["other:1", "native:999999", `native:${privateId}`, `native:0${notice.id}`];
    for (const bad of badCursors) {
      (
        await db.query(
          "INSERT INTO history_records(orb_id,record_id,parent_id,record) VALUES($1,$2,NULL,$3::json)",
          [orbId, bad, JSON.stringify({ ...records[0], id: bad })],
        )
      )._unsafeUnwrap();
      (
        await db.query("UPDATE orbs SET replication_cursor=$2 WHERE id=$1", [orbId, bad])
      )._unsafeUnwrap();
      await expect(
        storage.commit([[{ type: "entry", value: good }]], () => received.push(99), context),
      ).rejects.toMatchObject({
        cause: { code: "projection", message: "Public cursor absent from native history" },
      });
      expect(await storage.entry(good.id, context)).toBeUndefined();
      expect((await database.store.getOrb(task, orbId))._unsafeUnwrap()?.replicationCursor).toBe(
        bad,
      );
    }
    (
      await db.query("UPDATE orbs SET replication_cursor=$2 WHERE id=$1", [orbId, cursor])
    )._unsafeUnwrap();
    for (const bad of badCursors)
      (
        await db.query("DELETE FROM history_records WHERE orb_id=$1 AND record_id=$2", [orbId, bad])
      )._unsafeUnwrap();
    await expect(
      storage.commit(
        [[{ type: "entry", value: { ...good, id: older } }]],
        () => received.push(99),
        context,
      ),
    ).rejects.toMatchObject({
      cause: { code: "projection", message: "Native history batch precedes public cursor" },
    });
    expect(await storage.entry(older, context)).toBeUndefined();
    expect(received).toEqual([0, 1]);
    expect(
      await storage.commit(
        [[{ type: "entry", value: { ...good, id: older, kind: "pi.system" } }]],
        () => undefined,
        context,
      ),
    ).toEqual({ stored: 1 });
    (
      await db.query("UPDATE orbs SET harness_session_id='other' WHERE id=$1", [orbId])
    )._unsafeUnwrap();
    await expect(
      storage.commit([[{ type: "entry", value: good }]], () => received.push(99), context),
    ).rejects.toMatchObject({
      cause: { code: "projection", message: "Public history commit rejected" },
    });
    expect(await storage.entry(good.id, context)).toBeUndefined();
    (
      await db.query("UPDATE orbs SET harness_session_id='native' WHERE id=$1", [orbId])
    )._unsafeUnwrap();
    expect(
      (
        await db.query("SELECT record FROM history_records WHERE orb_id=$1 ORDER BY record_id", [
          orbId,
        ])
      )._unsafeUnwrap({ withStackTrace: true }).rows,
    ).toEqual(publicRows);
  } finally {
    await harness?.close(context);
    if (!harness) await storage?.close(context);
    await database.close();
  }
});

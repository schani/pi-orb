import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  defineDoc,
  type EntryId,
  type EntryRecord,
  Harness,
  type Storage,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import { NoSimulationTask } from "determined";
import { expect, it } from "vitest";
import { makeOrbRow, makeProjectRow, seedTestUser } from "../../testkit/fixtures.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { PgDurableAuthority } from "../durable-pg/index.ts";
import { PGliteClient } from "../pg/pglite-client.ts";
import { projectNativeCommit } from "./atomic-history.ts";

it("projects grouped native deltas without a loaded agent and rejects invalid cursor ancestry", async () => {
  const db = new PGliteClient();
  const database = composeControlPlaneDatabase(db);
  const task = new NoSimulationTask("atomic-native", false);
  const project = makeProjectRow(randomUUID());
  const orb = makeOrbRow(randomUUID(), project.id, "running");
  let harness: Harness | undefined;
  let storage: Storage | undefined;
  try {
    (await database.migrate())._unsafeUnwrap();
    (await seedTestUser(task, database.users))._unsafeUnwrap();
    (await database.store.insertProject(task, project))._unsafeUnwrap();
    (await database.store.insertOrb(task, orb))._unsafeUnwrap();
    const authority = new PgDurableAuthority(db, () => 0);
    const owner = (await authority.acquire(orb.id, "owner", 0, 0, 100))._unsafeUnwrap();
    const openStorage = async () =>
      (
        await authority.open(owner, {
          project: (query, writes) => projectNativeCommit(query, orb.id, writes),
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
    const wakeId = randomUUID();
    let privateId!: EntryId;
    const identity = defineDoc({
      kind: "orb.identity",
      version: 1,
      checkpointWhen: () => false,
      scope: "conversation",
      history: "latest",
      fork: "initial",
      initial: () => ({
        sessionId: "native",
        timestamp: 0,
        receipts: {
          wake: { messageIds: [wakeId], system: { kind: "sleep_wake", sleepUntil: "t" } },
        },
      }),
    });
    await root.commit(async (tx) => {
      await tx.doc(identity, root.id);
      privateId = (await tx.appendEntry(root.id, { kind: "pi.system" })).id;
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
    await harness.close(context);
    harness = undefined;
    storage = await openStorage();
    const ownedStorage = storage;
    const entry = async (content: string): Promise<EntryRecord> => ({
      id: await ownedStorage.mintId<EntryId>(),
      conversationId: root.id,
      kind: "pi.user",
      model: [{ role: "user", content, timestamp: 2 }],
    });
    const human = await entry("human"),
      wake = await entry("wake"),
      notice = await entry(
        JSON.stringify({ agent_id: "7", description: "task", message: "notice" }),
      );
    expect(
      await ownedStorage.commit(
        [
          [{ type: "entry", value: human }],
          [
            { type: "entry", value: notice },
            {
              type: "submission",
              value: {
                id: await ownedStorage.mintId<SubmissionId>(),
                conversationId: root.id,
                type: "input",
                status: "placed",
                entry: notice.id,
                requestId: "subagent-notify:7:test",
              },
            },
            {
              type: "submission",
              value: {
                id: await ownedStorage.mintId<SubmissionId>(),
                conversationId: root.id,
                type: "input",
                status: "placed",
                entry: wake.id,
                requestId: "inbox:wake",
              },
            },
            { type: "entry", value: wake },
          ],
        ],
        () => undefined,
        context,
      ),
    ).toEqual({ stored: 2 });
    const publicRows = (
      await db.query("SELECT record FROM history_records WHERE orb_id=$1 ORDER BY record_id", [
        orb.id,
      ])
    )._unsafeUnwrap().rows;
    const projected = publicRows
      .map((row) => row.record as { id: string; parentId: string | null })
      .sort((a, b) => Number(a.id.split(":").at(-1)) - Number(b.id.split(":").at(-1)));
    expect(projected.map(({ id, parentId }) => ({ id, parentId }))).toEqual([
      { id: row?.replicationCursor, parentId: null },
      { id: `native:${human.id}`, parentId: row?.replicationCursor },
      { id: `native:${wake.id}`, parentId: `native:${human.id}` },
      { id: `native:${notice.id}`, parentId: `native:${wake.id}` },
    ]);
    expect(projected[2]).toMatchObject({
      type: "event",
      custom: { customType: "pi-orb.sleep-wake" },
      inboxMessageIds: [wakeId],
    });
    expect(projected[3]).toMatchObject({
      type: "event",
      subagent: { kind: "notification", id: "7", description: "task", message: "notice" },
    });
    const cursor = `native:${notice.id}`;
    const good = await entry("rejected");
    for (const bad of [
      "other:1",
      "native:999999",
      `native:${privateId}`,
      `native:0${notice.id}`,
      cursor,
    ]) {
      if (bad !== cursor)
        (
          await db.query(
            "INSERT INTO history_records(orb_id,record_id,parent_id,record) VALUES($1,$2,NULL,$3::json)",
            [orb.id, bad, JSON.stringify({ ...projected[0], id: bad })],
          )
        )._unsafeUnwrap();
      (
        await db.query("UPDATE orbs SET replication_cursor=$2 WHERE id=$1", [orb.id, bad])
      )._unsafeUnwrap();
      const candidate = bad === cursor ? { ...good, id: older } : good;
      let receipted = false;
      await expect(
        ownedStorage.commit(
          [[{ type: "entry", value: candidate }]],
          () => {
            receipted = true;
          },
          context,
        ),
      ).rejects.toMatchObject({
        cause: {
          code: "projection",
          message:
            bad === cursor
              ? "Native history batch precedes public cursor"
              : "Public cursor absent from native history",
        },
      });
      expect(receipted).toBe(false);
      expect(await ownedStorage.entry(candidate.id, context)).toBeUndefined();
      expect((await database.store.getOrb(task, orb.id))._unsafeUnwrap()?.replicationCursor).toBe(
        bad,
      );
      if (bad !== cursor) {
        (
          await db.query("UPDATE orbs SET replication_cursor=$2 WHERE id=$1", [orb.id, cursor])
        )._unsafeUnwrap();
        (
          await db.query("DELETE FROM history_records WHERE orb_id=$1 AND record_id=$2", [
            orb.id,
            bad,
          ])
        )._unsafeUnwrap();
      }
    }
    expect(
      await ownedStorage.commit(
        [[{ type: "entry", value: { ...good, id: older, kind: "pi.system" } }]],
        () => undefined,
        context,
      ),
    ).toEqual({ stored: 1 });
    expect(
      (
        await db.query("SELECT record FROM history_records WHERE orb_id=$1 ORDER BY record_id", [
          orb.id,
        ])
      )._unsafeUnwrap().rows,
    ).toEqual(publicRows);
  } finally {
    if (harness) await harness.close(context);
    else await storage?.close(context);
    await database.close();
  }
});

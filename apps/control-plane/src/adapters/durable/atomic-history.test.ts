import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineDoc, Harness } from "@earendil-works/pi-durable";
import { NoSimulationTask } from "determined";
import { expect, it } from "vitest";
import { makeOrbRow, makeProjectRow } from "../../testkit/fixtures.ts";
import { composeControlPlaneDatabase } from "../database.ts";
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
    (
      await database.users.resolveUser(
        task,
        { issuer: "test", subject: "owner", email: null },
        { id: project.ownerUserId, now: 0 },
      )
    )._unsafeUnwrap();
    (await database.store.insertProject(task, project))._unsafeUnwrap();
    (await database.store.insertOrb(task, orb))._unsafeUnwrap();
    const authority = new PgDurableAuthority(db, () => 0);
    const owner = (await authority.acquire(orb.id, "owner", 0, 0, 100))._unsafeUnwrap();
    const storage = (
      await authority.open(owner, { project: (query) => projectNativeCommit(query, orb.id) })
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

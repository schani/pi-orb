import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineDoc, Harness } from "@earendil-works/pi-durable";
import { NoSimulationTask } from "determined";
import { expect, it } from "vitest";
import { makeOrbRow, makeProjectRow } from "../../testkit/fixtures.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { projectNativeCommit } from "../durable/atomic-history.ts";
import { PgAgentArtifacts } from "../durable/pg-artifacts.ts";
import { PgDurableAuthority } from "../durable-pg/index.ts";
import { PGliteClient } from "./pglite-client.ts";
import { PgResourceSnapshots } from "./resource-snapshots.ts";

it("seals the retained transcript and deletes private authority, resources and spills atomically", async () => {
  const db = new PGliteClient();
  const database = composeControlPlaneDatabase(db);
  const task = new NoSimulationTask("archive-private", false);
  const project = makeProjectRow(randomUUID());
  const orb = makeOrbRow(randomUUID(), project.id, "running");
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
    const owner = (await authority.acquire(orb.id, "test", 0, 0, 1000))._unsafeUnwrap();
    (await new PgAgentArtifacts(authority, owner).write(Buffer.from("private")))._unsafeUnwrap();
    (
      await new PgResourceSnapshots(db).put({
        orbId: orb.id,
        commitSha: "a".repeat(40),
        instructionPath: null,
        skillRoot: null,
        files: [],
      })
    )._unsafeUnwrap();
    (await db.query("UPDATE orbs SET state='archiving' WHERE id=$1", [orb.id]))._unsafeUnwrap();
    (
      await db.query(
        "INSERT INTO orb_deletions(orb_id,host_kind,kind,requested_at,cleanup_after,updated_at) VALUES($1,'process','archive',now(),now(),now())",
        [orb.id],
      )
    )._unsafeUnwrap();
    // An incorrect fence rolls back without deleting anything.
    expect(
      (
        await database.store.sealOrbArchive(task, {
          orbId: orb.id,
          expectedStateVersion: orb.stateVersion + 1,
          now: 0,
          cursor: null,
          headId: null,
        })
      ).isErr(),
    ).toBe(true);
    expect(
      (await db.query("SELECT count(*) AS n FROM orb_agent_artifacts"))._unsafeUnwrap().rows[0]?.n,
    ).toBe(1);
    const storage = (
      await authority.open(owner, { project: (query) => projectNativeCommit(query, orb.id) })
    )._unsafeUnwrap();
    const harness = await Harness.open(
      storage,
      { models: createModels(), registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    const root = await harness.root(BACKGROUND_CONTEXT);
    const identity = defineDoc({
      kind: "orb.identity",
      version: 1,
      scope: "conversation",
      history: "latest",
      fork: "initial",
      initial: () => ({ sessionId: "archive-session", timestamp: 0, receipts: {} }),
    });
    await root.commit(async (tx) => {
      await tx.doc(identity, root.id);
      await tx.appendEntry(root.id, {
        kind: "pi.message",
        model: [{ role: "user", content: "late committed history", timestamp: 1 }],
      });
    }, BACKGROUND_CONTEXT);
    await harness.close(BACKGROUND_CONTEXT);
    expect(
      (
        await database.store.sealOrbArchive(task, {
          orbId: orb.id,
          expectedStateVersion: orb.stateVersion,
          now: 0,
          cursor: null,
          headId: null,
        })
      ).isErr(),
    ).toBe(true);
    expect(
      (await db.query("SELECT count(*) AS n FROM orb_agent_artifacts"))._unsafeUnwrap().rows[0]?.n,
    ).toBe(1);
    const current = (await database.store.getOrb(task, orb.id))._unsafeUnwrap()!;
    (
      await database.store.sealOrbArchive(task, {
        orbId: orb.id,
        expectedStateVersion: orb.stateVersion,
        now: 0,
        cursor: current.replicationCursor,
        headId: current.replicatedHeadId,
      })
    )._unsafeUnwrap();
    expect(
      (
        await db.query("SELECT count(*) AS n FROM history_records WHERE orb_id=$1", [orb.id])
      )._unsafeUnwrap().rows[0]?.n,
    ).toBe(1);
    for (const table of [
      "durable_pg_durable_metadata",
      "orb_resource_snapshots",
      "orb_agent_artifacts",
    ]) {
      expect(
        (await db.query(`SELECT count(*) AS n FROM ${table}`))._unsafeUnwrap().rows[0]?.n,
      ).toBe(0);
    }
    expect(
      (
        await db.query("SELECT archived FROM durable_pg_owners WHERE orb_id=$1", [orb.id])
      )._unsafeUnwrap().rows[0]?.archived,
    ).toBe(true);
    expect((await authority.acquire(orb.id, "late", 0, 0, 1000)).isErr()).toBe(true);
    expect(
      (
        await db.query("SELECT history_sealed_at FROM orb_deletions WHERE orb_id=$1", [orb.id])
      )._unsafeUnwrap().rows[0]?.history_sealed_at,
    ).not.toBeNull();
  } finally {
    await database.close();
  }
});

import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { NoSimulationTask } from "determined";
import { expect, it } from "vitest";
import { makeOrbRow, makeProjectRow } from "../../testkit/fixtures.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { PgDurableAuthority } from "../durable-pg/index.ts";
import { PGliteClient } from "../pg/pglite-client.ts";
import { projectNativeCommit } from "./atomic-history.ts";

it("does not admit a native root submission after application inbox cancellation wins the orb lock", async () => {
  const db = new PGliteClient();
  const database = composeControlPlaneDatabase(db);
  const task = new NoSimulationTask("cancel-native", false);
  const project = makeProjectRow(randomUUID());
  const orb = makeOrbRow(randomUUID(), project.id, "starting");
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
    const messageId = randomUUID();
    (
      await db.query(
        "INSERT INTO orb_messages(orb_id,message_id,content,status,last_error) VALUES($1,$2,'[]','failed','Cancelled before agent admission')",
        [orb.id, messageId],
      )
    )._unsafeUnwrap();
    const authority = new PgDurableAuthority(db, () => 0);
    const owner = (await authority.acquire(orb.id, "owner", 0, 0, 1000))._unsafeUnwrap();
    const storage = (
      await authority.open(owner, {
        project: (query, writes) => projectNativeCommit(query, orb.id, writes),
      })
    )._unsafeUnwrap();
    harness = await Harness.open(
      storage,
      { models: createModels(), registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    const root = await harness.root(BACKGROUND_CONTEXT);
    await expect(
      root.submit(
        { type: "input", content: "cancelled", requestId: `inbox:${messageId}` },
        BACKGROUND_CONTEXT,
      ),
    ).rejects.toThrow();
    expect(
      (
        await db.query("SELECT count(*) AS n FROM durable_pg_submissions WHERE orb_id=$1", [orb.id])
      )._unsafeUnwrap().rows[0]?.n,
    ).toBe(0);
  } finally {
    await harness?.close(BACKGROUND_CONTEXT);
    await database.close();
  }
});

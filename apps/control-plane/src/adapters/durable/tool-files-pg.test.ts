import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { NoSimulationTask } from "determined";
import { okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { SnapshotResourceReader } from "../../domain/resources.ts";
import { makeOrbRow, makeProjectRow } from "../../testkit/fixtures.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { PgDurableAuthority } from "../durable-pg/index.ts";
import { PGliteClient } from "../pg/pglite-client.ts";
import { PgAgentArtifacts } from "./pg-artifacts.ts";
import { createAgentToolFiles } from "./tool-files.ts";

it("reads PG spills after owner reopen but not from another orb", async () => {
  const db = new PGliteClient();
  const database = composeControlPlaneDatabase(db);
  const task = new NoSimulationTask("scoped-files", false);
  const project = makeProjectRow(randomUUID());
  const orb = makeOrbRow(randomUUID(), project.id, "running");
  const other = makeOrbRow(randomUUID(), project.id, "running");
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
    for (const row of [orb, other]) (await database.store.insertOrb(task, row))._unsafeUnwrap();
    const authority = new PgDurableAuthority(db, () => 0);
    const owner = (await authority.acquire(orb.id, "first", 0, 0, 1000))._unsafeUnwrap();
    const reader = new SnapshotResourceReader({
      orbId: orb.id,
      commitSha: "a".repeat(40),
      instructionPath: null,
      skillRoot: null,
      files: [],
    });
    const first = createAgentToolFiles({
      reader,
      artifacts: new PgAgentArtifacts(authority, owner),
      allowSnapshotRead: () => true,
      check: () => okAsync(undefined),
    });
    const api = {} as ToolExecutionApi;
    const path = (await first.spill("one\ntwo\nthree", api, BACKGROUND_CONTEXT))._unsafeUnwrap();
    (await authority.release(owner))._unsafeUnwrap();
    const next = (await authority.acquire(orb.id, "next", 0, 0, 1000))._unsafeUnwrap();
    const reopened = createAgentToolFiles({
      reader,
      artifacts: new PgAgentArtifacts(authority, next),
      allowSnapshotRead: () => true,
      check: () => okAsync(undefined),
    });
    expect(
      (await reopened.read({ path, offset: 2, limit: 1 }, api, BACKGROUND_CONTEXT))._unsafeUnwrap()
        ?.content,
    ).toEqual([{ type: "text", text: "two" }]);
    const otherOwner = (await authority.acquire(other.id, "other", 0, 0, 1000))._unsafeUnwrap();
    const foreign = createAgentToolFiles({
      reader,
      artifacts: new PgAgentArtifacts(authority, otherOwner),
      allowSnapshotRead: () => true,
      check: () => okAsync(undefined),
    });
    expect((await foreign.read({ path }, api, BACKGROUND_CONTEXT)).isErr()).toBe(true);
  } finally {
    await database.close();
  }
});

import { randomUUID } from "node:crypto";
import type { ResourceWarning } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { expect, it, vi } from "vitest";
import { newOrbRow } from "../../domain/new-orb.ts";
import { makeOrbRow, makeProjectRow } from "../../testkit/fixtures.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { jsonParam } from "./client.ts";
import { PGliteClient } from "./pglite-client.ts";
import { PostgreSQLControlPlaneStore } from "./store.ts";

it("defaults resource warnings to an empty array in fixtures and mapped rows", async () => {
  const db = new PGliteClient();
  const database = composeControlPlaneDatabase(db);
  const task = new NoSimulationTask("resource-warning-mapping", false);
  const project = makeProjectRow(randomUUID());
  const orb = makeOrbRow(randomUUID(), project.id, "starting");
  try {
    expect(orb).toHaveProperty("resourceWarnings", []);
    (await database.migrate())._unsafeUnwrap();
    (
      await database.users.resolveUser(
        task,
        { issuer: "test", subject: "owner", email: null },
        { id: project.ownerUserId, now: 0 },
      )
    )._unsafeUnwrap();
    (await database.store.insertProject(task, project))._unsafeUnwrap();
    const inserted = (await database.store.insertOrb(task, orb))._unsafeUnwrap();
    expect(inserted).toHaveProperty("resourceWarnings", []);
    expect((await database.store.getOrb(task, orb.id))._unsafeUnwrap()).toHaveProperty(
      "resourceWarnings",
      [],
    );

    const query = db.query.bind(db);
    const spy = vi.spyOn(db, "query");
    for (const value of [null, undefined]) {
      spy.mockImplementationOnce((sql, values) =>
        query(sql, values).map((result) => ({
          ...result,
          rows: result.rows.map((row) => ({ ...row, resource_warnings: value })),
        })),
      );
      expect((await database.store.getOrb(task, orb.id))._unsafeUnwrap()).toHaveProperty(
        "resourceWarnings",
        [],
      );
    }
    spy.mockRestore();
  } finally {
    await database.close();
  }
});

it("reloads persisted resource warnings through a fresh PgStore", async () => {
  const db = new PGliteClient();
  const database = composeControlPlaneDatabase(db);
  const task = new NoSimulationTask("resource-warning-mapping", false);
  const project = makeProjectRow(randomUUID());
  const orb = makeOrbRow(randomUUID(), project.id, "starting");
  const warnings: ResourceWarning[] = [
    { path: ".pi/skills/bad/SKILL.md", code: "invalid_metadata" },
    { path: ".pi/skills/duplicate/SKILL.md", code: "duplicate_name" },
  ];
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
    (
      await db.query("UPDATE orbs SET resource_warnings=$2 WHERE id=$1", [
        orb.id,
        jsonParam(warnings),
      ])
    )._unsafeUnwrap();

    const reloaded = (
      await new PostgreSQLControlPlaneStore(db).getOrb(task, orb.id)
    )._unsafeUnwrap();
    expect(reloaded).toHaveProperty("resourceWarnings", warnings);
  } finally {
    await database.close();
  }
});

it("starts new orbs with no resource warnings", () => {
  expect(newOrbRow({ orbId: randomUUID(), projectId: randomUUID() }, "process", 0)).toHaveProperty(
    "resourceWarnings",
    [],
  );
});

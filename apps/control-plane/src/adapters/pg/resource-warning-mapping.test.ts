import { randomUUID } from "node:crypto";
import type { ResourceWarning } from "@pi-orb/protocol";
import { expect, it, vi } from "vitest";
import { newOrbRow } from "../../domain/new-orb.ts";
import { openOrbSqlFixture } from "../../testkit/sql-fixture.ts";
import { jsonParam } from "./client.ts";
import { PostgreSQLControlPlaneStore } from "./store.ts";

it("defaults resource warnings to an empty array in fixtures and mapped rows", async () => {
  const { db, database, task, orb, inserted } = await openOrbSqlFixture(
    "resource-warning-mapping",
    "starting",
  );
  {
    expect(orb).toHaveProperty("resourceWarnings", []);
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
  }
});

it("reloads persisted resource warnings through a fresh PgStore", async () => {
  const { db, task, orb } = await openOrbSqlFixture("resource-warning-mapping", "starting");
  const warnings: ResourceWarning[] = [
    { path: ".pi/skills/bad/SKILL.md", code: "invalid_metadata" },
    { path: ".pi/skills/duplicate/SKILL.md", code: "duplicate_name" },
  ];
  {
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
  }
});

it("starts new orbs with no resource warnings", () => {
  expect(newOrbRow({ orbId: randomUUID(), projectId: randomUUID() }, "process", 0)).toHaveProperty(
    "resourceWarnings",
    [],
  );
});

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { errAsync } from "neverthrow";
import { expect, it } from "vitest";
import type { ResourceSnapshot } from "../../domain/resources.ts";
import { PgClient } from "./client.ts";
import { PgResourceSnapshots } from "./resource-snapshots.ts";

const url = process.env["PI_ORB_TEST_DATABASE_URL"];
it.skipIf(!url)("resource snapshot atomicity and admission on real PostgreSQL", async () => {
  if (!url) return;
  const schema = `resource_${randomUUID().replaceAll("-", "")}`;
  const admin = new PgClient(url);
  expect((await admin.query(`CREATE SCHEMA ${schema}`)).isOk()).toBe(true);
  const scoped = new URL(url);
  scoped.searchParams.set("options", `-csearch_path=${schema}`);
  const client = new PgClient(scoped.href);
  const reader = new PgClient(scoped.href);
  const orbId = "00000000-0000-4000-8000-000000000001";
  try {
    expect((await client.query("CREATE TABLE orbs(id uuid PRIMARY KEY)")).isOk()).toBe(true);
    const migration = await readFile(
      new URL("./migrations/037_resource_snapshots.sql", import.meta.url),
      "utf8",
    );
    expect((await client.transaction(async (_query, execute) => execute(migration))).isOk()).toBe(
      true,
    );
    await client.query("INSERT INTO orbs VALUES($1)", [orbId]);
    const snapshot = {
      orbId,
      commitSha: "a".repeat(40),
      instructionPath: null,
      skillRoot: null,
      files: [{ path: "asset", sha256: "invalid", bytes: Buffer.from([0, 255]) }],
    };
    const store = new PgResourceSnapshots(client);
    expect((await store.put(snapshot)).isErr()).toBe(true);
    const reopened = new PgResourceSnapshots(reader);
    expect((await reopened.get(orbId))._unsafeUnwrap()).toBe(null);
    const guard = new PgResourceSnapshots(client, () =>
      errAsync({
        type: "store_error",
        code: "invariant",
        message: "Admission revoked",
        retryable: false,
      }),
    );
    expect((await guard.put({ ...snapshot, files: [] })).isErr()).toBe(true);
    expect((await reopened.get(orbId))._unsafeUnwrap()).toBe(null);
    const candidates: [ResourceSnapshot, ResourceSnapshot] = [
      {
        ...snapshot,
        instructionPath: "AGENTS.md",
        files: [
          {
            path: "AGENTS.md",
            bytes: Buffer.from([0, 255, 1]),
            sha256: createHash("sha256")
              .update(Buffer.from([0, 255, 1]))
              .digest("hex"),
          },
        ],
        warnings: [{ path: ".pi/skills/first/SKILL.md", code: "invalid_yaml" as const }],
      },
      {
        ...snapshot,
        commitSha: "b".repeat(40),
        instructionPath: "SECOND.md",
        files: [
          {
            path: "SECOND.md",
            bytes: Buffer.from([2, 254, 3]),
            sha256: createHash("sha256")
              .update(Buffer.from([2, 254, 3]))
              .digest("hex"),
          },
        ],
        warnings: [{ path: ".pi/skills/second/SKILL.md", code: "invalid_metadata" as const }],
      },
    ];
    const [a, b] = await Promise.all([
      store.put(candidates[0]),
      new PgResourceSnapshots(reader).put(candidates[1]),
    ]);
    const first = a._unsafeUnwrap();
    const second = b._unsafeUnwrap();
    expect(first.commitSha).toBe(second.commitSha);
    for (const result of [first, second]) {
      const candidate = candidates.find((entry) => entry.commitSha === result.commitSha);
      expect(candidate).toBeDefined();
      expect(result).toEqual(candidate);
      expect(result.warnings).toEqual(candidate?.warnings);
    }
    const winner = candidates.find((entry) => entry.commitSha === first.commitSha);
    const reloaded = (await reopened.get(orbId))._unsafeUnwrap();
    expect(reloaded).toEqual(winner);
    expect(reloaded?.warnings).toEqual(winner?.warnings);
    const projected = (
      await reader.query(
        "SELECT commit_sha,manifest->'warnings' AS warnings FROM orb_resource_snapshots WHERE orb_id=$1",
        [orbId],
      )
    )._unsafeUnwrap();
    expect(projected.rows).toEqual([{ commit_sha: first.commitSha, warnings: winner?.warnings }]);
    await store.remove(orbId);
    expect((await reopened.get(orbId))._unsafeUnwrap()).toBe(null);
  } finally {
    await client.end();
    await reader.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

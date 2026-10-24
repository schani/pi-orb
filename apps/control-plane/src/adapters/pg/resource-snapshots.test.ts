import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { errAsync, okAsync } from "neverthrow";
import { afterEach, describe, expect, it } from "vitest";
import type { ResourceSnapshot } from "../../domain/resources.ts";
import { PGliteClient } from "./pglite-client.ts";
import { PgResourceSnapshots } from "./resource-snapshots.ts";

const orbId = "00000000-0000-4000-8000-000000000001";
describe("resource snapshot PostgreSQL persistence", () => {
  const clients: PGliteClient[] = [];
  afterEach(async () => {
    for (const result of await Promise.all(clients.splice(0).map((client) => client.end()))) {
      expect(result.isOk(), JSON.stringify(result)).toBe(true);
    }
  });
  it("rolls back cancellation after a file insert, before publication commits", async () => {
    const client = new PGliteClient();
    clients.push(client);
    await client.query("CREATE TABLE orbs(id uuid PRIMARY KEY)");
    await client.transaction(async (_query, execute) =>
      execute(
        await readFile(new URL("./migrations/037_resource_snapshots.sql", import.meta.url), "utf8"),
      ),
    );
    await client.query("INSERT INTO orbs VALUES($1)", [orbId]);
    const controller = new AbortController();
    const transaction = client.transaction.bind(client);
    client.transaction = (callback) =>
      transaction((query, execute) =>
        callback(
          (sql, values) =>
            query(sql, values).map((result) => {
              if (sql.startsWith("INSERT INTO orb_resource_files")) controller.abort();
              return result;
            }),
          execute,
        ),
      );
    const store = new PgResourceSnapshots(client, () =>
      controller.signal.aborted
        ? errAsync({
            type: "store_error",
            code: "invariant",
            message: "cancelled",
            retryable: false,
          })
        : okAsync(undefined),
    );
    const result = await store.put({
      orbId,
      commitSha: "a".repeat(40),
      instructionPath: "AGENTS.md",
      skillRoot: null,
      files: [
        {
          path: "AGENTS.md",
          bytes: Buffer.from("one"),
          sha256: createHash("sha256").update("one").digest("hex"),
        },
      ],
    });
    expect(controller.signal.aborted).toBe(true);
    expect(result.isErr()).toBe(true);
    expect((await store.get(orbId))._unsafeUnwrap()).toBeNull();
  });
  it("atomically publishes bytes and manifest, reopens, pins once and cleans private data", async () => {
    const client = new PGliteClient();
    clients.push(client);
    expect((await client.query("CREATE TABLE orbs(id uuid PRIMARY KEY)")).isOk()).toBe(true);
    expect(
      (
        await client.transaction(async (_query, execute) =>
          execute(
            await readFile(
              new URL("./migrations/037_resource_snapshots.sql", import.meta.url),
              "utf8",
            ),
          ),
        )
      ).isOk(),
    ).toBe(true);
    await client.query("INSERT INTO orbs VALUES($1)", [orbId]);
    const store = new PgResourceSnapshots(client);
    const snapshot = {
      orbId,
      commitSha: "a".repeat(40),
      instructionPath: "AGENTS.md",
      skillRoot: null,
      files: [
        {
          path: "AGENTS.md",
          sha256: createHash("sha256")
            .update(Buffer.from([0, 255, 1]))
            .digest("hex"),
          bytes: Buffer.from([0, 255, 1]),
        },
      ],
    };
    expect((await store.put(snapshot)).isOk()).toBe(true);
    const reopened = await new PgResourceSnapshots(client).get(orbId);
    expect(reopened.isOk() && reopened.value?.files[0]?.bytes).toEqual(Buffer.from([0, 255, 1]));
    const retry = await store.put({ ...snapshot, commitSha: "b".repeat(40) });
    expect(retry.isOk() && retry.value.commitSha).toBe("a".repeat(40));
    await client.query("UPDATE orb_resource_files SET bytes=$2 WHERE orb_id=$1", [
      orbId,
      Buffer.from("corrupt"),
    ]);
    expect((await store.get(orbId)).isErr()).toBe(true);
    await store.remove(orbId);
    expect((await store.get(orbId))._unsafeUnwrap()).toBe(null);
  });
  it("rolls back a manifest when asset insert fails", async () => {
    const client = new PGliteClient();
    clients.push(client);
    await client.query("CREATE TABLE orbs(id uuid PRIMARY KEY)");
    await client.transaction(async (_query, execute) =>
      execute(
        await readFile(new URL("./migrations/037_resource_snapshots.sql", import.meta.url), "utf8"),
      ),
    );
    await client.query("INSERT INTO orbs VALUES($1)", [orbId]);
    const store = new PgResourceSnapshots(client);
    const r = await store.put({
      orbId,
      commitSha: "a".repeat(40),
      instructionPath: null,
      skillRoot: null,
      files: [
        {
          path: "x",
          sha256: createHash("sha256").update("x").digest("hex"),
          bytes: Buffer.from("x"),
        },
        {
          path: "x",
          sha256: createHash("sha256").update("x").digest("hex"),
          bytes: Buffer.from("x"),
        },
      ],
    });
    expect(r.isErr()).toBe(true);
    expect((await store.get(orbId))._unsafeUnwrap()).toBe(null);
  });
});

it("persists only warning code/path, defaults legacy manifests, and rejects malformed warnings", async () => {
  const client = new PGliteClient();
  try {
    (await client.query("CREATE TABLE orbs(id uuid PRIMARY KEY)"))._unsafeUnwrap();
    (
      await client.transaction(async (_query, execute) =>
        execute(
          await readFile(
            new URL("./migrations/037_resource_snapshots.sql", import.meta.url),
            "utf8",
          ),
        ),
      )
    )._unsafeUnwrap();
    (await client.query("INSERT INTO orbs VALUES($1)", [orbId]))._unsafeUnwrap();
    const warnings = [
      { path: ".pi/skills/bad/SKILL.md", code: "invalid_yaml" as const, content: "PRIVATE YAML" },
      { path: ".pi/skills/duplicate/SKILL.md", code: "duplicate_name" as const },
    ];
    const expected = warnings.map(({ path, code }) => ({ path, code }));
    const store = new PgResourceSnapshots(client);
    const snapshot = {
      orbId,
      commitSha: "a".repeat(40),
      instructionPath: null,
      skillRoot: null,
      files: [],
    };
    const warning = { path: "skills/bad/SKILL.md", code: "invalid_yaml" as const };
    const invalid = [
      Array.from({ length: 5001 }, () => warning),
      [{ ...warning, path: "x".repeat(1025) }],
      [{ ...warning, code: "unknown" }],
    ];
    for (const warnings of invalid) {
      expect(
        (
          await store.put({
            ...snapshot,
            // Malformed runtime input at the persistence boundary.
            warnings: warnings as NonNullable<ResourceSnapshot["warnings"]>,
          })
        ).isErr(),
      ).toBe(true);
      expect((await store.get(orbId))._unsafeUnwrap()).toBeNull();
    }
    const published = (
      await store.put({
        ...snapshot,
        warnings,
      })
    )._unsafeUnwrap();
    expect(published.warnings).toEqual(expected);
    expect((await new PgResourceSnapshots(client).get(orbId))._unsafeUnwrap()?.warnings).toEqual(
      expected,
    );
    const manifest = (
      await client.query("SELECT manifest FROM orb_resource_snapshots WHERE orb_id=$1", [orbId])
    )._unsafeUnwrap().rows[0]?.manifest;
    expect(JSON.stringify(manifest)).not.toContain("PRIVATE YAML");
    (
      await client.query(
        "UPDATE orb_resource_snapshots SET manifest=manifest - 'warnings' WHERE orb_id=$1",
        [orbId],
      )
    )._unsafeUnwrap();
    expect((await store.get(orbId))._unsafeUnwrap()?.warnings).toEqual([]);
    for (const warnings of invalid) {
      (
        await client.query(
          "UPDATE orb_resource_snapshots SET manifest=jsonb_set(manifest,'{warnings}',$2::jsonb) WHERE orb_id=$1",
          [orbId, JSON.stringify(warnings)],
        )
      )._unsafeUnwrap();
      expect((await store.get(orbId)).isErr()).toBe(true);
    }
  } finally {
    await client.end();
  }
});

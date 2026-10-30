import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PGliteClient } from "./pglite-client.ts";

it.each(["memory", "disk"])("registers pg_textsearch for %s databases", async (kind) => {
  const root = kind === "disk" ? mkdtempSync(join(tmpdir(), "pg-textsearch-")) : undefined;
  const client = new PGliteClient(root === undefined ? undefined : join(root, "db"));
  try {
    (await client.query("CREATE EXTENSION pg_textsearch WITH SCHEMA public"))._unsafeUnwrap();
    expect(
      (
        await client.query(
          "SELECT extversion, extnamespace::regnamespace::text AS schema FROM pg_extension WHERE extname = 'pg_textsearch'",
        )
      )._unsafeUnwrap().rows,
    ).toEqual([{ extversion: "1.5.1", schema: "public" }]);
  } finally {
    (await client.end())._unsafeUnwrap();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

it("reopens disk databases with pg_textsearch and persisted rows", async () => {
  const root = mkdtempSync(join(tmpdir(), "pg-textsearch-reopen-"));
  const path = join(root, "db");
  let client = new PGliteClient(path);
  try {
    (await client.query("CREATE EXTENSION pg_textsearch WITH SCHEMA public"))._unsafeUnwrap();
    (await client.query("CREATE TABLE reopen_proof (body text)"))._unsafeUnwrap();
    (await client.query("INSERT INTO reopen_proof VALUES ($1)", ["persisted"]))._unsafeUnwrap();
    (await client.end())._unsafeUnwrap();
    client = new PGliteClient(path);
    expect(
      (
        await client.query(
          "SELECT body, extversion FROM reopen_proof CROSS JOIN pg_extension WHERE extname = 'pg_textsearch'",
        )
      )._unsafeUnwrap().rows,
    ).toEqual([{ body: "persisted", extversion: "1.5.1" }]);
  } finally {
    (await client.end())._unsafeUnwrap();
    rmSync(root, { recursive: true, force: true });
  }
});

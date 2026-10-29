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

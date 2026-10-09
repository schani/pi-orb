import { expect, it } from "vitest";
import { scopedSql } from "./executor.ts";

it("scopes multiline document writes and every placeholder", () => {
  expect(scopedSql("INSERT INTO documents\n (id, record)\n VALUES (?, ?)")).toBe(
    "INSERT INTO durable_pg_documents (orb_id, id, record)\n VALUES ($1, $2, $3)",
  );
});

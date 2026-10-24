import { errAsync, okAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import type { StoreError } from "../../domain/errors.ts";
import { executor } from "./executor.ts";
import { StorageFailure } from "./storage-boundary.ts";

const record = '{"text":"? \' $2; DROP TABLE documents; --"}';
it.each([
  {
    sql: "SELECT record, '?' AS literal FROM durable_pg_documents WHERE orb_id = $1 AND id = $2",
    values: [7],
  },
  {
    sql: `INSERT INTO durable_pg_documents (orb_id, id, record) VALUES ($1, $2, $3)
ON CONFLICT (orb_id, id) DO UPDATE SET record = excluded.record /* ? */`,
    values: [7, record],
  },
  {
    sql: "UPDATE durable_pg_documents SET record = $3 WHERE orb_id = $1 AND id = $2",
    values: [7, record],
  },
  {
    sql: "DELETE FROM durable_pg_document_revisions WHERE orb_id = $1 AND document_id = $2",
    values: [7],
  },
])(
  "passes native SQL unchanged and prepends only the orb binding: $sql",
  async ({ sql, values }) => {
    const query = vi.fn(() => okAsync({ rows: [], rowCount: 0 }));
    await executor(query, "tenant").run(sql, ...values);
    expect(query).toHaveBeenCalledExactlyOnceWith(sql, ["tenant", ...values]);
  },
);

it("normalizes only known bigint columns and preserves bound values and JSON", async () => {
  const query = vi.fn(() =>
    okAsync({
      rows: [
        {
          id: "7",
          next_seq: "8",
          commit_seq: "9",
          seq: "10",
          version: "11",
          next_id: "12",
          record: '{"id":"13","text":"?"}',
          kind: "?",
          nullable: null,
        },
      ],
      rowCount: 1,
    }),
  );
  const sql =
    "SELECT * FROM durable_pg_tasks WHERE orb_id=$1 AND id=$2 AND kind IS NOT DISTINCT FROM $3";
  expect(await executor(query, "tenant").get(sql, 7, null)).toEqual({
    id: 7,
    next_seq: 8,
    commit_seq: 9,
    seq: 10,
    version: 11,
    next_id: "12",
    record: '{"id":"13","text":"?"}',
    kind: "?",
    nullable: null,
  });
  expect(query).toHaveBeenCalledExactlyOnceWith(sql, ["tenant", 7, null]);
});

it("returns all rows and undefined for an empty get", async () => {
  const query = vi.fn(() => okAsync({ rows: [{ id: "1" }, { id: "2" }], rowCount: 2 }));
  const storage = executor(query, "tenant");
  const sql = "SELECT id FROM durable_pg_tasks WHERE orb_id=$1";
  expect(await storage.all(sql)).toEqual([{ id: 1 }, { id: 2 }]);
  query.mockReturnValueOnce(okAsync({ rows: [], rowCount: 0 }));
  expect(await storage.get(sql)).toBeUndefined();
});

it.each(["get", "all", "run"] as const)(
  "retains the typed database failure from %s",
  async (method) => {
    const cause: StoreError = {
      type: "store_error",
      code: "unavailable",
      message: "injected IO",
      retryable: true,
    };
    const query = vi.fn(() => errAsync(cause));
    const result = executor(query, "tenant")[method](
      "SELECT id FROM durable_pg_tasks WHERE orb_id=$1",
    );
    await expect(result).rejects.toBeInstanceOf(StorageFailure);
    await expect(result).rejects.toMatchObject({
      message: "Durable database operation failed",
      cause,
    });
  },
);

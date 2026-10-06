import type { StorageWrite } from "@earendil-works/pi-durable";
import { okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { hasPublicHistoryWrites } from "./atomic-history.ts";

it("does not read history for task/progress/private-child commits", async () => {
  let queries = 0;
  const query = () => {
    queries++;
    return okAsync({ rows: [], rowCount: 0 });
  };
  expect(
    (
      await hasPublicHistoryWrites(query, "orb", [
        { type: "task", value: { conversationId: 1 } },
        { type: "entry", value: { conversationId: 7 } },
      ] as StorageWrite[])
    )._unsafeUnwrap(),
  ).toBe(false);
  expect(queries).toBe(0);
  expect(
    (
      await hasPublicHistoryWrites(query, "orb", [
        { type: "document.change", id: 42 },
      ] as StorageWrite[])
    )._unsafeUnwrap(),
  ).toBe(false);
  expect(queries).toBe(1);
});
it("retains root entry and receipt/identity enrichment commits", async () => {
  const query = () => okAsync({ rows: [{ id: 42 }], rowCount: 1 });
  expect(
    (
      await hasPublicHistoryWrites(query, "orb", [
        { type: "entry", value: { conversationId: 1 } },
      ] as StorageWrite[])
    )._unsafeUnwrap(),
  ).toBe(true);
  expect(
    (
      await hasPublicHistoryWrites(query, "orb", [
        { type: "document.change", id: 42 },
      ] as StorageWrite[])
    )._unsafeUnwrap(),
  ).toBe(true);
  expect(
    (
      await hasPublicHistoryWrites(query, "orb", [
        { type: "submission", value: { conversationId: 1, entry: 5 } },
      ] as StorageWrite[])
    )._unsafeUnwrap(),
  ).toBe(true);
});

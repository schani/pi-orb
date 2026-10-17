import type { HistoryRecord } from "@pi-orb/protocol";
import { expect, it } from "vitest";
import { orderHistoryForPresentation as orderHistory } from "./history-presentation.ts";

const record = (id: string, parentId: string | null, day = 7): HistoryRecord => ({
  id,
  parentId,
  timestamp: `2026-08-${String(day).padStart(2, "0")}T00:00:00.000Z`,
  type: "message",
  role: "assistant",
  content: [],
  overflow: {},
});

it("keeps earlier components before compaction despite a backdated descendant", () => {
  const earlier = record("earlier", null, 4);
  const output = record("earlier-output", earlier.id, 9);
  const compact = record("compact", null, 8);
  const backdated = record("backdated", compact.id, 3);
  const cursor = record("cursor", backdated.id, 2);
  const input = [cursor, compact, output, backdated, earlier];
  const expected = [earlier, output, compact, backdated, cursor];
  expect(orderHistory(input, cursor.id)._unsafeUnwrap()).toEqual(expected);
  expect(orderHistory(input.toReversed(), cursor.id)._unsafeUnwrap()).toEqual(expected);
  expect(input[0]).toBe(cursor);
});

it("prioritizes ready siblings by timestamp then ID, not depth-first ancestry", () => {
  const root = record("root", null);
  const a = record("a", root.id);
  const b = record("b", root.id);
  const deep = record("deep", a.id, 9);
  const cursor = record("cursor", b.id, 1);
  expect(orderHistory([deep, cursor, b, a, root], cursor.id)._unsafeUnwrap()).toEqual([
    root,
    a,
    b,
    deep,
    cursor,
  ]);
});

it("orders arbitrary timestamp strings consistently across input permutations", () => {
  const z = { ...record("z", null), timestamp: "2026-01-01" };
  const m = { ...record("m", null), timestamp: "bad" };
  const a = { ...record("a", null), timestamp: "2026-01-03" };
  const cursor = record("cursor", null);
  for (const roots of [
    [z, m, a],
    [z, a, m],
    [m, z, a],
    [m, a, z],
    [a, z, m],
    [a, m, z],
  ]) {
    expect(orderHistory([...roots, cursor], cursor.id)._unsafeUnwrap()).toEqual([m, z, a, cursor]);
  }
});

it("walks more than 6000 ancestors without recursion", () => {
  const records = Array.from({ length: 6501 }, (_, i) =>
    record(String(i), i === 0 ? null : String(i - 1)),
  );
  expect(orderHistory([...records].reverse(), "6500")._unsafeUnwrap()).toEqual(records);
});

it.each([
  { records: [record("root", null)], cursor: "missing" },
  { records: [record("a", "b"), record("b", "a")], cursor: "a" },
  { records: [record("a", "b"), record("b", "a"), record("cursor", null)], cursor: "cursor" },
  { records: [record("a", "missing")], cursor: "a" },
  { records: [record("a", null), record("b", "a")], cursor: "a" },
])(
  "returns a typed corruption error for an impossible snapshot: $cursor",
  ({ records, cursor }) => {
    const result = orderHistory(records, cursor);
    expect(result.isErr() && result.error).toMatchObject({
      type: "store_error",
      code: "corruption",
      retryable: false,
    });
  },
);

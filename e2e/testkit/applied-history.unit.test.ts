import type { DisplayHistoryView } from "@pi-orb/protocol";
import type { Page } from "@playwright/test";
import { afterEach, expect, it, vi } from "vitest";
import { waitForAppliedHistory } from "./applied-history.ts";

const history: DisplayHistoryView = {
  orbId: "child",
  session: { id: "session" },
  cursor: "completion",
  headId: "completion",
  records: [],
};
const applied = {
  orbId: history.orbId,
  sessionId: history.session?.id ?? null,
  cursor: history.cursor,
  headId: history.headId,
  recordCount: history.records.length,
};
afterEach(() => vi.unstubAllGlobals());

it.each([
  null,
  { ...applied, orbId: "other-child" },
  { ...applied, sessionId: "other-session" },
  { ...applied, cursor: "old-cursor" },
  { ...applied, headId: "old-head" },
  { ...applied, recordCount: 1 },
])("requires the exact applied child snapshot: %j", async (initial) => {
  let current = initial;
  vi.stubGlobal("piOrbDebug", { dump: () => ({ current }) });
  const waitForFunction = vi.fn(
    async (
      predicate: (expected: typeof applied) => boolean,
      expected: typeof applied,
      options: { timeout: number },
    ) => {
      expect(predicate(expected)).toBe(false);
      current = applied;
      expect(predicate(expected)).toBe(true);
      expect(options).toEqual({ timeout: 30_000 });
    },
  );
  await waitForAppliedHistory({ waitForFunction } as unknown as Page, history);
  expect(waitForFunction).toHaveBeenCalledOnce();
});

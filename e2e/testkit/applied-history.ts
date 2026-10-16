import type { DisplayHistoryView } from "@pi-orb/protocol";
import type { Page } from "@playwright/test";

/** Cold application ownership, not HTTP fulfillment or a cold-start latency threshold. */
export async function waitForAppliedHistory(
  page: Page,
  history: DisplayHistoryView,
): Promise<void> {
  await page.waitForFunction(
    (expected) => {
      const current = (
        globalThis as unknown as {
          piOrbDebug?: { dump(): { current: typeof expected | null } };
        }
      ).piOrbDebug?.dump().current;
      return (
        current?.orbId === expected.orbId &&
        current.sessionId === expected.sessionId &&
        current.cursor === expected.cursor &&
        current.headId === expected.headId &&
        current.recordCount === expected.recordCount
      );
    },
    {
      orbId: history.orbId,
      sessionId: history.session?.id ?? null,
      cursor: history.cursor,
      headId: history.headId,
      recordCount: history.records.length,
    },
    { timeout: 30_000 },
  );
}

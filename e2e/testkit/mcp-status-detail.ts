import { CommittedDisplayDetailSchema, type DisplayHistoryView } from "@pi-orb/protocol";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import { Check } from "typebox/value";

export type McpDetailError = {
  type: "detail_missing" | "detail_unavailable" | "invalid_detail";
  status: number;
};
export type DetailRequest = (
  path: string,
) => Promise<{ status: number; body: Record<string, unknown> }>;

export async function hasCommittedMcpStatus(
  history: DisplayHistoryView,
  status: "needs-auth" | "connected",
  request: DetailRequest,
): Promise<Result<boolean, McpDetailError>> {
  const marker = `MCP fixture: ${status}.`;
  const records = history.records.filter((record) => record.type !== "compaction");
  // Guest status entries remain inline; central tool results use committed details.
  if (
    records.some((record) =>
      record.content?.some((block) => block.type === "text" && block.text.includes(marker)),
    )
  )
    return ok(true);
  if (!history.session) return ok(false);
  let pending: McpDetailError | undefined;
  for (const record of records) {
    for (const block of record.content ?? []) {
      if (block.type !== "tool_result") continue;
      const path = `/api/v1/orbs/${encodeURIComponent(history.orbId)}/details/${encodeURIComponent(record.id)}/${encodeURIComponent(block.detailKey)}?sessionId=${encodeURIComponent(history.session.id)}`;
      const response = await ResultAsync.fromPromise(request(path), () => ({
        type: "detail_unavailable" as const,
        status: 0,
      }));
      if (response.isErr()) return err(response.error);
      if (response.value.status === 404) {
        pending = { type: "detail_missing", status: 404 };
        continue;
      }
      if (response.value.status !== 200)
        return err({ type: "detail_unavailable", status: response.value.status });
      const detail = response.value.body;
      if (
        !Check(CommittedDisplayDetailSchema, detail) ||
        detail.sessionId !== history.session.id ||
        detail.recordId !== record.id ||
        detail.detailKey !== block.detailKey ||
        detail.body.type !== "tool_result"
      )
        return err({ type: "invalid_detail", status: 200 });
      if (detail.body.content.some((item) => item.type === "text" && item.text.includes(marker)))
        return ok(true);
    }
  }
  return pending ? err(pending) : ok(false);
}

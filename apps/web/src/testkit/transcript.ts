import type { HistoryRecord, OrbHistoryView } from "@pi-orb/protocol";

export function history(orbId = "a", ids = ["one"], sessionId = "session"): OrbHistoryView {
  return {
    orbId,
    session: { id: sessionId, overflow: {} },
    records: ids.map(
      (id, i): HistoryRecord => ({
        id,
        parentId: ids[i - 1] ?? null,
        timestamp: "now",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: id }],
        overflow: {},
      }),
    ),
    cursor: ids.at(-1) ?? null,
    headId: ids.at(-1) ?? null,
  };
}

import {
  type DisplayHistoryView,
  type HistoryRecord,
  projectDisplayRecord,
} from "@pi-orb/protocol";

export function history(orbId = "a", ids = ["one"], sessionId = "session"): DisplayHistoryView {
  return {
    orbId,
    session: { id: sessionId },
    records: ids.map((id, i) =>
      projectDisplayRecord({
        id,
        parentId: ids[i - 1] ?? null,
        timestamp: "now",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: id }],
        overflow: {},
      } satisfies HistoryRecord),
    ),
    cursor: ids.at(-1) ?? null,
    headId: ids.at(-1) ?? null,
  };
}

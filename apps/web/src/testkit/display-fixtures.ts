import { type DisplayRecord, type HistoryRecord, projectDisplayRecord } from "@pi-orb/protocol";
import type { DetailContext } from "../components/DetailBody.tsx";
import { TranscriptCache } from "../lib/transcript-cache.ts";

export const displayRecord = (record: HistoryRecord): DisplayRecord => projectDisplayRecord(record);

export function detailContext(): DetailContext {
  return {
    orbId: "orb",
    sessionId: "session",
    connected: false,
    operationId: null,
    cache: new TranscriptCache(),
    getOwner: () => null,
    livePending: new Map(),
    committedPending: new Map(),
    imagePending: new Map(),
  };
}

export function messageNotice(
  messagePreview: string,
  id: string,
  childId: string,
  description: string,
): Extract<DisplayRecord, { type: "event" }> {
  return {
    id,
    parentId: null,
    timestamp: "2026-10-02T00:00:00Z",
    type: "event",
    eventType: "pi.custom_message",
    custom: { customType: "subagent-notification", display: true },
    subagent: {
      kind: "notification",
      id: childId,
      description,
      detailKey: `${id}:subagent`,
      messagePreview,
    },
  };
}

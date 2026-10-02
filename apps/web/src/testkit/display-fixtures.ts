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

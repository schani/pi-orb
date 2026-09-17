import type { HistoryRecord, OrbMessageView, ServerFrame } from "@pi-orb/protocol";

const TRACE_LIMIT = 200;
const ANOMALY_LIMIT = 50;
const ID_LIMIT = 128;
const IDS_PER_ENTRY = 20;

export type DebugTraceEvent =
  | "navigation"
  | "cache"
  | "connection"
  | "frame_rejected"
  | "frame_received"
  | "sync_state";

export interface DebugTraceInput {
  event: DebugTraceEvent;
  orbId?: string | null | undefined;
  outcome?: string | null | undefined;
  frameType?: string | null | undefined;
  textLength?: number | undefined;
  connectionId?: string | null | undefined;
  runtimeInstanceId?: string | null | undefined;
  sessionId?: string | null | undefined;
  syncMode?: "full" | "after" | undefined;
  recordId?: string | null | undefined;
  parentId?: string | null | undefined;
  headId?: string | null | undefined;
  inboxMessageIds?: readonly string[] | undefined;
  cursorBefore?: string | null | undefined;
  cursorAfter?: string | null | undefined;
  recordCount?: number | undefined;
}

interface DebugTraceEntry extends DebugTraceInput {
  seq: number;
  at: string;
  inboxMessageIdsTotal?: number;
  inboxMessageIdsTruncated?: boolean;
}

interface TranscriptProjection {
  orbId: string;
  sessionId: string | null;
  records: ReadonlyMap<string, HistoryRecord>;
  afterRecordId: string | null;
  headId: string | null;
  synced: boolean;
  connection: string;
  queuedMessages: readonly OrbMessageView[];
}

export interface PiOrbDebugDump {
  version: 1;
  capturedAt: string;
  scope: "current-tab";
  limitations: readonly string[];
  traceCapacity: number;
  traceDropped: number;
  trace: readonly DebugTraceEntry[];
  current: null | {
    orbId: string;
    sessionId: string | null;
    connection: string;
    synced: boolean;
    recordCount: number;
    cursor: string | null;
    headId: string | null;
    anomalies: {
      missingOrOutOfOrderParents: readonly {
        recordId: string;
        parentId: string;
        index: number;
      }[];
      cursorIsLastRecord: boolean;
      headPresent: boolean;
      total: number;
      truncated: boolean;
    };
    unmatchedInbox: readonly { id: string; status: string }[];
    unmatchedInboxTotal: number;
    unmatchedInboxTruncated: boolean;
  };
}

function boundedId(value: string): string;
function boundedId(value: null): null;
function boundedId(value: undefined): undefined;
function boundedId(value: string | null): string | null;
function boundedId(value: string | null | undefined): string | null | undefined;
function boundedId(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  return value.slice(0, ID_LIMIT);
}

function finiteCount(value: number | undefined): number | undefined {
  return value === undefined
    ? undefined
    : Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
}

function safeTrace(input: DebugTraceInput, seq: number): DebugTraceEntry {
  return {
    seq,
    at: new Date().toISOString(),
    event: input.event,
    ...(input.orbId !== undefined ? { orbId: boundedId(input.orbId) } : {}),
    ...(input.outcome !== undefined ? { outcome: boundedId(input.outcome) } : {}),
    ...(input.frameType !== undefined ? { frameType: boundedId(input.frameType) } : {}),
    ...(input.textLength !== undefined ? { textLength: finiteCount(input.textLength) } : {}),
    ...(input.connectionId !== undefined ? { connectionId: boundedId(input.connectionId) } : {}),
    ...(input.runtimeInstanceId !== undefined
      ? { runtimeInstanceId: boundedId(input.runtimeInstanceId) }
      : {}),
    ...(input.sessionId !== undefined ? { sessionId: boundedId(input.sessionId) } : {}),
    ...(input.syncMode !== undefined ? { syncMode: input.syncMode } : {}),
    ...(input.recordId !== undefined ? { recordId: boundedId(input.recordId) } : {}),
    ...(input.parentId !== undefined ? { parentId: boundedId(input.parentId) } : {}),
    ...(input.headId !== undefined ? { headId: boundedId(input.headId) } : {}),
    ...(input.inboxMessageIds !== undefined
      ? {
          inboxMessageIds: input.inboxMessageIds
            .slice(0, IDS_PER_ENTRY)
            .map((id) => id.slice(0, ID_LIMIT)),
          inboxMessageIdsTotal: input.inboxMessageIds.length,
          inboxMessageIdsTruncated: input.inboxMessageIds.length > IDS_PER_ENTRY,
        }
      : {}),
    ...(input.cursorBefore !== undefined ? { cursorBefore: boundedId(input.cursorBefore) } : {}),
    ...(input.cursorAfter !== undefined ? { cursorAfter: boundedId(input.cursorAfter) } : {}),
    ...(input.recordCount !== undefined ? { recordCount: finiteCount(input.recordCount) } : {}),
  };
}

function summarize(projection: TranscriptProjection): NonNullable<PiOrbDebugDump["current"]> {
  const seen = new Set<string>();
  const representedInbox = new Set<string>();
  const anomalies: { recordId: string; parentId: string; index: number }[] = [];
  let anomalyCount = 0;
  let lastId: string | null = null;
  let index = 0;
  for (const record of projection.records.values()) {
    if (record.parentId !== null && !seen.has(record.parentId)) {
      anomalyCount += 1;
      if (anomalies.length < ANOMALY_LIMIT)
        anomalies.push({
          recordId: boundedId(record.id) ?? "",
          parentId: boundedId(record.parentId) ?? "",
          index,
        });
    }
    if (record.type === "message")
      for (const id of record.inboxMessageIds ?? []) representedInbox.add(id);
    seen.add(record.id);
    lastId = record.id;
    index += 1;
  }
  const unmatched = projection.queuedMessages.filter(
    (message) => !representedInbox.has(message.id),
  );
  return {
    orbId: boundedId(projection.orbId) ?? "",
    sessionId: boundedId(projection.sessionId),
    connection: boundedId(projection.connection) ?? "unknown",
    synced: projection.synced,
    recordCount: projection.records.size,
    cursor: boundedId(projection.afterRecordId),
    headId: boundedId(projection.headId),
    anomalies: {
      missingOrOutOfOrderParents: anomalies,
      cursorIsLastRecord: projection.afterRecordId === lastId,
      headPresent: projection.headId === null || seen.has(projection.headId),
      total: anomalyCount,
      truncated: anomalyCount > anomalies.length,
    },
    unmatchedInbox: unmatched.slice(0, ANOMALY_LIMIT).map((message) => ({
      id: boundedId(message.id) ?? "",
      status: boundedId(message.status) ?? "unknown",
    })),
    unmatchedInboxTotal: unmatched.length,
    unmatchedInboxTruncated: unmatched.length > ANOMALY_LIMIT,
  };
}

export class DevConsoleDebug {
  private trace: DebugTraceEntry[] = [];
  private seq = 0;
  private dropped = 0;
  private owner: object | null = null;
  private projection: (() => TranscriptProjection) | null = null;

  record(input: DebugTraceInput): void {
    this.trace.push(safeTrace(input, ++this.seq));
    if (this.trace.length > TRACE_LIMIT) {
      const overflow = this.trace.length - TRACE_LIMIT;
      this.trace.splice(0, overflow);
      this.dropped += overflow;
    }
  }

  ownCurrent(getProjection: () => TranscriptProjection): () => void {
    const owner = {};
    this.owner = owner;
    this.projection = getProjection;
    return () => {
      if (this.owner !== owner) return;
      this.owner = null;
      this.projection = null;
    };
  }

  dump(): PiOrbDebugDump {
    return {
      version: 1,
      capturedAt: new Date().toISOString(),
      scope: "current-tab",
      limitations: [
        "In-memory evidence only; reload and tab close erase it.",
        "The bounded trace may omit older events and cannot prove transport delivery.",
        "Only the currently owned conversation is summarized.",
      ],
      traceCapacity: TRACE_LIMIT,
      traceDropped: this.dropped,
      trace: this.trace.map((entry) =>
        entry.inboxMessageIds === undefined
          ? { ...entry }
          : { ...entry, inboxMessageIds: [...entry.inboxMessageIds] },
      ),
      current: this.projection === null ? null : summarize(this.projection()),
    };
  }
}

export const devConsoleDebug = new DevConsoleDebug();

export function installDevConsoleDebug(target: Window): void {
  if (Object.hasOwn(target, "piOrbDebug")) return;
  Object.defineProperty(target, "piOrbDebug", {
    configurable: false,
    enumerable: true,
    value: Object.freeze({ dump: () => devConsoleDebug.dump() }),
    writable: false,
  });
  console.log(
    "Before refreshing, run copy(piOrbDebug.dump()) (metadata only; no message contents).",
  );
}

export function historyFrameDebug(frame: ServerFrame): Partial<DebugTraceInput> {
  if (frame.type !== "history.record") return {};
  return {
    recordId: frame.record.id,
    parentId: frame.record.parentId,
    headId: frame.headId,
    ...(frame.record.type === "message" && frame.record.inboxMessageIds !== undefined
      ? { inboxMessageIds: frame.record.inboxMessageIds }
      : {}),
  };
}

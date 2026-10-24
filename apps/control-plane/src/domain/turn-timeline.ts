import {
  type HistoryRecord,
  isUserBand,
  type JsonValue,
  piTurnStarts,
  type TimelineRow,
  type TurnTimeline,
} from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { errAsync, type ResultAsync } from "neverthrow";
import type { StoreError } from "./errors.ts";
import type { ModelCall } from "./model-usage.ts";
import type { ControlPlaneStore } from "./ports.ts";

/** A `model_calls` row as read back: the ledger's fields and the time it was recorded (the call's end). */
export type RecordedModelCall = Omit<ModelCall, "ownerUserId" | "orbId"> & { readonly at: number };

/** Root calls by response ID; every other use whose start (`at − duration_ms`) is in `[from, until)`. */
export interface TurnCallQuery {
  readonly responseIds: readonly string[];
  readonly from: number;
  readonly until: number;
}

/**
 * How long after its last recorded activity a turn still owns side calls such as its turn summary.
 * Later calls (headlines generated when someone reads the transcript a day later) are not the turn's.
 */
export const TURN_SIDE_CALL_GRACE_MS = 60_000;

export interface TurnCallReader {
  readTurnCalls(
    task: SimulationTask,
    orbId: string,
    query: TurnCallQuery,
  ): ResultAsync<RecordedModelCall[], StoreError>;
}

export interface TurnTimelineDeps {
  readonly store: Pick<ControlPlaneStore, "getOrb" | "readHistorySnapshot">;
  readonly modelUsage: TurnCallReader;
}

export type TurnTimelineError =
  | { readonly type: "orb_missing" }
  | { readonly type: "not_pi" }
  | { readonly type: "turn_missing" }
  | {
      readonly type: "store_error";
      readonly source: "orb" | "history" | "model_calls";
      readonly error: StoreError;
    };

type MessageRecord = Extract<HistoryRecord, { type: "message" }>;
type ToolCallBlock = Extract<MessageRecord["content"][number], { type: "tool_call" }>;
type ModelRow = Extract<TimelineRow, { kind: "model" }>;
type ToolRow = Extract<TimelineRow, { kind: "tool" }>;

const SAID_CHARS = 500;
const LINE_CHARS = 200;
/** Argument keys that name what a tool call is about, in preference order. */
const ARG_KEYS = ["command", "path", "file_path", "pattern", "query", "url", "description", "name"];

function bounded(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function firstLine(text: string): string | undefined {
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part !== "");
  return line === undefined ? undefined : bounded(line, LINE_CHARS);
}

function textOf(content: readonly { type: string; text?: string }[] | undefined): string {
  return (content ?? [])
    .flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : []))
    .join("\n")
    .trim();
}

function object(value: JsonValue | undefined): { [key: string]: JsonValue } | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/** The native Pi message a record was projected from (docs/pi-adapter.md). */
function nativeMessage(record: HistoryRecord): { [key: string]: JsonValue } | null {
  return object(object(record.overflow["native"])?.["message"]);
}

function number(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

/** Epoch-millisecond time of a record; null for unparseable times and epoch placeholders. */
function time(timestamp: string): number | null {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function argument(block: ToolCallBlock): string | undefined {
  const args = object(block.arguments);
  for (const key of ARG_KEYS) {
    const value = args?.[key];
    if (typeof value === "string") return firstLine(value);
  }
  return undefined;
}

function nestedStatus(status: JsonValue | undefined): ToolRow["status"] {
  return status === "ok" || status === "error" || status === "cancelled" ? status : "unfinished";
}

function callRow(id: string, call: RecordedModelCall, start: number): ModelRow {
  return {
    kind: "model",
    id,
    start,
    end: call.at,
    use: call.use,
    model: call.model,
    ...(call.ttftMs === undefined ? {} : { ttftMs: call.ttftMs }),
    ...(call.thinkingMs === undefined ? {} : { thinkingMs: call.thinkingMs }),
    input: call.input,
    output: call.output,
    cacheRead: call.cacheRead,
    cacheWrite: call.cacheWrite,
    ...(call.costUsd === undefined ? {} : { costUsd: call.costUsd }),
    stop: call.outcome,
  };
}

const callStart = (call: RecordedModelCall) => Math.max(0, call.at - (call.durationMs ?? 0));

function assistantRow(
  record: MessageRecord,
  start: number,
  roots: ReadonlyMap<string, RecordedModelCall>,
): ModelRow {
  const native = nativeMessage(record);
  const responseId = native?.["responseId"];
  const joined = typeof responseId === "string" ? roots.get(responseId) : undefined;
  const usage = record.usage;
  const said = textOf(record.content);
  return {
    kind: "model",
    id: record.id,
    start,
    end: start + (number(native?.["durationMs"]) ?? 0),
    use: "root",
    model: record.model?.id ?? "",
    ...(joined?.ttftMs === undefined ? {} : { ttftMs: joined.ttftMs }),
    ...(joined?.thinkingMs === undefined ? {} : { thinkingMs: joined.thinkingMs }),
    ...(usage?.inputTokens === undefined ? {} : { input: usage.inputTokens }),
    ...(usage?.outputTokens === undefined ? {} : { output: usage.outputTokens }),
    ...(usage?.cacheReadTokens === undefined ? {} : { cacheRead: usage.cacheReadTokens }),
    ...(usage?.cacheWriteTokens === undefined ? {} : { cacheWrite: usage.cacheWriteTokens }),
    ...(usage?.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
    ...(record.finishReason === undefined ? {} : { stop: record.finishReason }),
    ...(record.failure === undefined ? {} : { error: record.failure.message }),
    ...(said === "" ? {} : { said: bounded(said, SAID_CHARS) }),
  };
}

function markerOf(
  record: Extract<HistoryRecord, { type: "event" }>,
): Pick<Extract<TimelineRow, { kind: "marker" }>, "marker" | "text"> | null {
  const text = (value: string | undefined) =>
    value === undefined || value === "" ? {} : { text: bounded(value, SAID_CHARS) };
  if (record.alert !== undefined) return { marker: "alert", ...text(record.alert.message) };
  if (record.subagent?.kind === "notification")
    return {
      marker: "notification",
      ...text(record.subagent.description ?? record.subagent.message),
    };
  if (record.custom?.customType === "pi-orb.harness-restarted") return { marker: "restart" };
  if (record.custom?.customType === "pi-orb.sleep-wake")
    return { marker: "wake", ...text(textOf(record.content)) };
  if (record.eventType === "orb.message" && record.sender !== undefined)
    return { marker: "message", ...text(textOf(record.content)) };
  return null;
}

/**
 * One Pi turn as waterfall rows (docs/web-ui.md "Pi transcript timeline"): the turn's public history
 * records from `turn[0]` (its user band) plus the orb's `model_calls` rows for it. Times are epoch ms.
 */
function assembleTurnTimeline(
  turn: readonly HistoryRecord[],
  start: number,
  calls: readonly RecordedModelCall[],
): TurnTimeline {
  const roots = new Map(
    calls.flatMap((call) =>
      call.use === "root" && call.responseId !== undefined
        ? [[call.responseId, call] as const]
        : [],
    ),
  );
  const rows: TimelineRow[] = [];
  const nested = new Map<string, ToolRow[]>();
  const pending = new Map<string, { block: ToolCallBlock; at: number }>();
  const compactions: { id: string; at: number }[] = [];
  for (const record of turn.slice(1)) {
    const at = time(record.timestamp);
    if (at === null) continue;
    if (record.type === "compaction") {
      compactions.push({ id: record.id, at });
      continue;
    }
    if (record.type === "event") {
      const marker = markerOf(record);
      if (marker !== null) rows.push({ kind: "marker", id: record.id, start: at, ...marker });
      continue;
    }
    if (record.role === "user") {
      if (isUserBand(record)) {
        const text = textOf(record.content);
        rows.push({
          kind: "marker",
          id: record.id,
          start: at,
          marker: "steering",
          ...(text === "" ? {} : { text: bounded(text, SAID_CHARS) }),
        });
      }
      continue;
    }
    if (record.role === "assistant") {
      const row = assistantRow(record, at, roots);
      rows.push(row);
      for (const block of record.content)
        if (block.type === "tool_call") pending.set(block.callId, { block, at: row.end });
      continue;
    }
    const native = nativeMessage(record);
    for (const block of record.content) {
      if (block.type !== "tool_result") continue;
      const call = pending.get(block.callId);
      if (call === undefined) continue;
      pending.delete(block.callId);
      const duration = number(native?.["durationMs"]);
      const details = object(native?.["details"]);
      const inner = Array.isArray(details?.["calls"]) ? details["calls"] : undefined;
      const result = firstLine(textOf(block.content));
      const arg = argument(call.block);
      rows.push({
        kind: "tool",
        id: block.callId,
        start: duration === undefined ? call.at : Math.max(0, at - duration),
        end: at,
        name: call.block.name,
        ...(arg === undefined ? {} : { arg }),
        nested: false,
        status: block.isError === true ? "error" : "ok",
        ...(result === undefined ? {} : { result }),
        ...(inner === undefined ? {} : { calls: inner.length }),
      });
      const children = (inner ?? []).flatMap((value, index): ToolRow[] => {
        const entry = object(value);
        const started = typeof entry?.["startedAt"] === "string" ? time(entry["startedAt"]) : null;
        if (entry === null || started === null) return [];
        return [
          {
            kind: "tool",
            id: `${block.callId}:${typeof entry["id"] === "number" ? entry["id"] : index}`,
            start: started,
            end: started + (number(entry["durationMs"]) ?? 0),
            name: typeof entry["name"] === "string" ? entry["name"] : "",
            nested: true,
            status: nestedStatus(entry["status"]),
          },
        ];
      });
      if (children.length > 0)
        nested.set(
          block.callId,
          children.sort((a, b) => a.start - b.start),
        );
    }
  }
  for (const { block, at } of pending.values()) {
    const arg = argument(block);
    rows.push({
      kind: "tool",
      id: block.callId,
      start: at,
      end: at,
      name: block.name,
      ...(arg === undefined ? {} : { arg }),
      nested: false,
      status: "unfinished",
    });
  }
  // A compaction record pairs with the latest compaction call since the previous one.
  const paired = new Set<RecordedModelCall>();
  let after = Number.NEGATIVE_INFINITY;
  for (const compaction of compactions.sort((a, b) => a.at - b.at)) {
    const match = calls
      .filter((call) => call.use === "compaction" && call.at > after && call.at <= compaction.at)
      .at(-1);
    after = compaction.at;
    if (match === undefined) {
      rows.push({ kind: "marker", id: compaction.id, start: compaction.at, marker: "compaction" });
      continue;
    }
    paired.add(match);
    rows.push(callRow(compaction.id, match, callStart(match)));
  }
  calls.forEach((call, index) => {
    if (call.use !== "root" && !paired.has(call))
      rows.push(callRow(`call:${index}`, call, callStart(call)));
  });
  return {
    start,
    rows: rows
      .sort((a, b) => a.start - b.start)
      .flatMap((row): TimelineRow[] =>
        row.kind === "tool" ? [row, ...(nested.get(row.id) ?? [])] : [row],
      ),
  };
}

/** The waterfall of one Pi turn, addressed by the turn's user record ID. */
export function readTurnTimeline(
  task: SimulationTask,
  deps: TurnTimelineDeps,
  orbId: string,
  turnId: string,
): ResultAsync<TurnTimeline, TurnTimelineError> {
  const failed = (source: "orb" | "history" | "model_calls") => (error: StoreError) =>
    ({ type: "store_error", source, error }) as const;
  return deps.store
    .getOrb(task, orbId)
    .mapErr(failed("orb"))
    .andThen((orb) => {
      if (orb === null || orb.state === "deleting")
        return errAsync({ type: "orb_missing" } as const);
      if (orb.harness !== "pi") return errAsync({ type: "not_pi" } as const);
      return deps.store.readHistorySnapshot(task, orbId).mapErr(failed("history"));
    })
    .andThen(({ records }) => {
      const starts = piTurnStarts(records);
      const index = starts.has(turnId) ? records.findIndex((record) => record.id === turnId) : -1;
      const from = index === -1 ? null : time(records[index]?.timestamp ?? "");
      if (from === null) return errAsync({ type: "turn_missing" } as const);
      const next = records.findIndex((record, at) => at > index && starts.has(record.id));
      const turn = records.slice(index, next === -1 ? undefined : next);
      const responseIds: string[] = [];
      let last = from;
      for (const record of turn) {
        const native = record.type === "message" ? nativeMessage(record) : null;
        const responseId = native?.["responseId"];
        if (typeof responseId === "string") responseIds.push(responseId);
        // Assistant records are stamped when their request starts; everything else when it happened.
        const duration = record.type === "message" && record.role === "assistant" ? native : null;
        last = Math.max(
          last,
          (time(record.timestamp) ?? 0) + (number(duration?.["durationMs"]) ?? 0),
        );
      }
      const nextStart = next === -1 ? null : time(records[next]?.timestamp ?? "");
      const until = Math.min(nextStart ?? Number.POSITIVE_INFINITY, last + TURN_SIDE_CALL_GRACE_MS);
      return deps.modelUsage
        .readTurnCalls(task, orbId, { responseIds, from, until })
        .mapErr(failed("model_calls"))
        .map((calls) => assembleTurnTimeline(turn, from, calls));
    });
}

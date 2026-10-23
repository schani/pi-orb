import type { HistoryRecord } from "@pi-orb/protocol";
import { BOOT_BASELINE_TYPE, HOST_RESTARTED_TYPE } from "./boot-policy.ts";
import type { ClaudeHistory } from "./history.ts";

type BootMarker = Extract<HistoryRecord, { type: "event" }>;

function passiveBootMarker(record: HistoryRecord): boolean {
  return (
    record.type === "event" &&
    record.eventType === HOST_RESTARTED_TYPE &&
    record.overflow.operationId === undefined
  );
}

/** The native receipt, not submission or public success, proves context was appended. */
export function pendingBootContext(records: readonly HistoryRecord[]): BootMarker[] {
  const received = new Set(
    records.flatMap((record) =>
      record.type === "event" && record.eventType === "claude.boot_receipt"
        ? [record.overflow.operationId]
        : [],
    ),
  );
  return records.filter(
    (record): record is BootMarker =>
      record.type === "event" && passiveBootMarker(record) && !received.has(record.id),
  );
}

/** A transcript-only acknowledgement is not the querying input's completion. */
export function classifyPassiveBootResult(
  history: Pick<ClaudeHistory, "view" | "correlation">,
  result: {
    readonly subtype: string;
    readonly is_error: boolean;
    readonly num_turns: number;
    readonly user_message_uuid?: string;
    readonly user_message_uuids?: readonly string[];
  },
): "not_passive" | "pending_receipt" | "durable" {
  if (result.subtype !== "success" || result.is_error || result.num_turns !== 0)
    return "not_passive";
  const ids =
    result.user_message_uuids ??
    (result.user_message_uuid === undefined ? [] : [result.user_message_uuid]);
  const passive = ids.filter((id) => {
    const provenance = history.correlation(id);
    return (
      provenance?.boot === true &&
      history.view.some(
        (marker) => marker.id === provenance.operationId && passiveBootMarker(marker),
      )
    );
  });
  if (passive.length === 0) return "not_passive";
  if (passive.length !== ids.length) return "pending_receipt";
  return ids.every((id) =>
    history.view.some(
      (record) =>
        record.id === id &&
        record.type === "event" &&
        record.eventType === "claude.boot_receipt" &&
        record.overflow.operationId === history.correlation(id)?.operationId,
    ),
  )
    ? "durable"
    : "pending_receipt";
}

/** Adapt native root evidence to the pure boot policy. */
export function claudeBootEntries(records: readonly HistoryRecord[]): unknown[] {
  const humanReceipts = new Map(
    records.flatMap((record) =>
      record.type === "event" &&
      record.eventType === "claude.input_receipt" &&
      record.overflow.inputKind === "human" &&
      typeof record.overflow.attachmentId === "string"
        ? [[record.overflow.attachmentId, record.id] as const]
        : [],
    ),
  );
  return records.flatMap((record): unknown[] => {
    // A late appended receipt contributes human authority only at its native attachment position.
    const inputUuid = humanReceipts.get(record.id);
    if (inputUuid !== undefined)
      return [{ type: "message", id: inputUuid, message: { role: "user", content: [] } }];
    if (record.type === "message") {
      const native = record.overflow.native;
      if (
        native !== null &&
        typeof native === "object" &&
        !Array.isArray(native) &&
        (native.isCompactSummary === true || native.isMeta === true)
      )
        return [];
      const content = record.content.map((block) =>
        block.type === "tool_call" ? { type: "toolCall" } : block,
      );
      return [
        {
          type: "message",
          id: record.id,
          message: {
            role: record.role === "tool" ? "toolResult" : record.role,
            content,
            stopReason: record.finishReason === "tool_use" ? "toolUse" : record.finishReason,
          },
        },
      ];
    }
    if (record.type !== "event") return [];
    if (record.eventType === BOOT_BASELINE_TYPE || passiveBootMarker(record))
      return [{ type: "custom", customType: record.eventType, data: record.overflow }];
    if (
      [
        "pi-orb.turn-resume",
        "pi-orb.turn-resume-declined",
        "pi-orb.host-restarted",
        "pi-orb.sleep-wake",
        "pi-orb.restart-notification-failed",
      ].includes(record.eventType)
    )
      return [
        {
          type: "custom_message",
          id: record.id,
          customType: record.eventType,
          details: record.overflow,
        },
      ];
    if (record.eventType === "claude.operation_finished" && record.overflow.work !== "compaction")
      return [
        {
          type: "message",
          id: record.id,
          message: {
            role: "assistant",
            content: [],
            stopReason:
              record.overflow.outcome === "aborted"
                ? "aborted"
                : record.overflow.outcome === "failed"
                  ? "error"
                  : "stop",
          },
        },
      ];
    return [];
  });
}

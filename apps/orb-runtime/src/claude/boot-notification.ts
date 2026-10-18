import type { HistoryRecord } from "@pi-orb/protocol";
import { BOOT_BASELINE_TYPE } from "./boot-policy.ts";

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
    if (record.eventType === BOOT_BASELINE_TYPE)
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

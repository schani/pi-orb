import type { HistoryRecord } from "@pi-orb/protocol";
import { BOOT_BASELINE_TYPE } from "../pi/boot-notification.ts";

/** Adapt native root evidence to the shared pure boot policy, never to a Pi session. */
export function claudeBootEntries(records: readonly HistoryRecord[]): unknown[] {
  return records.flatMap((record): unknown[] => {
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

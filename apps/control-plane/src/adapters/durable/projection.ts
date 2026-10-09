import type { ConversationId, EntryRecord, TaskGraph } from "@earendil-works/pi-durable";
import type { ActiveSubagent, HistoryRecord } from "@pi-orb/protocol";
import { err, ok, type Result } from "neverthrow";
import { type MappingError, mapPiEntry } from "../../../../orb-runtime/src/pi/mapping.ts";

export function activeSubagents(graph: TaskGraph, rootId: ConversationId): ActiveSubagent[] {
  const children = new Map<string, ActiveSubagent>();
  const priority = { queued: 0, running: 1, finishing: 2 };
  for (const task of Object.values(graph.tasks)) {
    for (const id of [task.conversationId, ...task.conversations]) {
      if (id === rootId) continue;
      const phase =
        task.abortRequested || task.state.status === "completing"
          ? "finishing"
          : task.state.status === "pending"
            ? "queued"
            : "running";
      const existing = children.get(String(id));
      if (!existing || priority[phase] > priority[existing.phase])
        children.set(String(id), { id: String(id), description: `Subagent ${id}`, phase });
    }
  }
  return [...children.values()];
}

/** Only displayable root data enters public history; native prompt/configuration state stays private. */
export function projectEntry(
  entry: EntryRecord,
  parentId: string | null,
  sessionId: string,
): Result<HistoryRecord | null, MappingError> {
  const id = `${sessionId}:${entry.id}`;
  if (entry.kind === "pi.system" || entry.kind === "pi.reset" || entry.kind === "orb.identity")
    return ok(null);
  const data =
    entry.data !== null && typeof entry.data === "object" && !Array.isArray(entry.data)
      ? entry.data
      : {};
  if (entry.kind === "orb.model-change" || entry.kind === "orb.thinking-level-change")
    return mapPiEntry({
      id,
      parentId,
      timestamp: new Date(
        typeof data["timestamp"] === "number" ? data["timestamp"] : 0,
      ).toISOString(),
      ...(entry.kind === "orb.model-change"
        ? { type: "model_change", provider: data["provider"], modelId: data["modelId"] }
        : { type: "thinking_level_change", thinkingLevel: data["thinkingLevel"] }),
    });
  if (entry.kind === "orb.instructions-adoption")
    return mapPiEntry({
      id,
      parentId,
      timestamp: new Date(
        typeof data["timestamp"] === "number" ? data["timestamp"] : 0,
      ).toISOString(),
      type: "custom",
      customType: data["customType"],
      data: data["data"],
    });
  if (entry.kind === "orb.harness-restarted") {
    return ok({
      id,
      parentId,
      timestamp: new Date(
        typeof data["timestamp"] === "number" ? data["timestamp"] : 0,
      ).toISOString(),
      overflow: { taskIds: data["taskIds"] ?? [] },
      type: "event",
      eventType: "pi.custom_message",
      content: [
        {
          type: "text",
          text: "Agent harness restarted with unfinished work; recovery is resuming.",
        },
      ],
      custom: { customType: "pi-orb.harness-restarted", display: true },
    });
  }
  if (entry.kind === "orb.alert") {
    return ok({
      id,
      parentId,
      timestamp: new Date(
        typeof data["timestamp"] === "number" ? data["timestamp"] : 0,
      ).toISOString(),
      overflow: {},
      type: "event",
      eventType: "orb.alert",
      alert: { message: String(data["message"] ?? ""), requestId: String(data["requestId"] ?? "") },
    });
  }
  if (entry.kind === "pi.compaction") {
    const summary =
      entry.model
        ?.flatMap((message) =>
          typeof message.content === "string"
            ? [message.content]
            : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
        )
        .join("\n") ?? "";
    return ok({
      id,
      parentId,
      timestamp: new Date(0).toISOString(),
      overflow: {},
      type: "compaction",
      summary: [{ type: "text", text: summary }],
    });
  }
  const message = entry.model?.[0];
  if (
    !message ||
    (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult")
  )
    return ok(null);
  return mapPiEntry({
    id,
    parentId,
    timestamp: new Date(message.timestamp).toISOString(),
    type: "message",
    message,
  });
}

export interface PublicEntryReceipt {
  readonly messageIds: readonly string[];
  readonly system?: { readonly kind: string };
}

export function projectHistory(
  entries: readonly EntryRecord[],
  sessionId: string,
  receipts: ReadonlyMap<number, PublicEntryReceipt> = new Map(),
): Result<readonly HistoryRecord[], MappingError> {
  const records: HistoryRecord[] = [];
  for (const entry of entries) {
    const projected = projectEntry(entry, records.at(-1)?.id ?? null, sessionId);
    if (projected.isErr()) return err(projected.error);
    if (!projected.value) continue;
    const receipt = receipts.get(entry.id);
    const record = projected.value;
    records.push(
      record.type === "message" && receipt?.system
        ? {
            id: record.id,
            parentId: record.parentId,
            timestamp: record.timestamp,
            type: "event",
            eventType: "pi.custom_message",
            content: record.content,
            custom: {
              customType:
                receipt.system.kind === "sleep_wake"
                  ? "pi-orb.sleep-wake"
                  : "pi-orb.system-message",
              display: true,
            },
            inboxMessageIds: [...receipt.messageIds],
            overflow: {},
          }
        : record.type === "message" && receipt
          ? { ...record, inboxMessageIds: [...receipt.messageIds] }
          : record,
    );
  }
  return ok(records);
}

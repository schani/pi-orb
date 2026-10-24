import type { JsonObject, JsonValue } from "@earendil-works/pi-ai";
import type { ConversationId, EntryRecord, TaskGraph } from "@earendil-works/pi-durable";
import {
  type ActiveSubagent,
  capHeadline,
  type HistoryRecord,
  OrbMessageSystemSchema,
  type SystemInput,
  systemInputEvent,
} from "@pi-orb/protocol";
import { err, ok, Result } from "neverthrow";
import { Check } from "typebox/value";
import {
  type MappingError,
  mapPiEntry,
  mapUserContent,
} from "../../../../orb-runtime/src/domain/mapping.ts";

export function activeSubagents(
  graph: TaskGraph,
  rootId: ConversationId,
  records: readonly HistoryRecord[] = [],
): ActiveSubagent[] {
  const headers = new Map(
    records.flatMap((record) =>
      record.type === "event" && record.subagentTask !== undefined
        ? [
            [
              record.subagentTask.id,
              {
                description:
                  record.subagentTask.description.trim() !== ""
                    ? capHeadline(record.subagentTask.description)
                    : `Subagent ${record.subagentTask.id}`,
                ...(record.subagentTask.description.trim() === "" &&
                record.subagentTask.prompt.trim() !== ""
                  ? { taskRecordId: record.id }
                  : {}),
              },
            ] as const,
          ]
        : [],
    ),
  );
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
        children.set(String(id), {
          id: String(id),
          description: `Subagent ${id}`,
          ...headers.get(String(id)),
          phase,
        });
    }
  }
  return [...children.values()];
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Nested execution inputs stay private even in the mapper's lossless native overflow. */
function publicMessage(message: NonNullable<EntryRecord["model"]>[number]) {
  if (message.role !== "toolResult" || message.toolName !== "codemode") return message;
  const details = message.details;
  if (!isJsonObject(details) || !Array.isArray(details.calls)) return message;
  return {
    ...message,
    details: {
      ...details,
      calls: details.calls.flatMap((call: JsonValue) => {
        if (!isJsonObject(call)) return [];
        return [
          {
            ...(typeof call.id === "number" ? { id: call.id } : {}),
            ...(typeof call.name === "string" ? { name: call.name } : {}),
            ...(typeof call.status === "string" ? { status: call.status } : {}),
            ...(typeof call.startedAt === "string" ? { startedAt: call.startedAt } : {}),
            ...(typeof call.durationMs === "number" ? { durationMs: call.durationMs } : {}),
            argumentKeys:
              Array.isArray(call.argumentKeys) &&
              call.argumentKeys.every((key: JsonValue) => typeof key === "string")
                ? call.argumentKeys
                : [],
          },
        ];
      }),
    },
  };
}

/** Root transcript and child launch metadata are public history; native configuration stays private. */
export function projectEntry(
  entry: EntryRecord,
  parentId: string | null,
  sessionId: string,
  peer?: Pick<SystemInput, "sender" | "inboxMessageIds">,
): Result<HistoryRecord | null, MappingError> {
  const id = `${sessionId}:${entry.id}`;
  if (entry.kind === "pi.system" || entry.kind === "pi.reset" || entry.kind === "orb.identity")
    return ok(null);
  const data =
    entry.data !== null && typeof entry.data === "object" && !Array.isArray(entry.data)
      ? entry.data
      : {};
  if (
    entry.kind === "orb.subagent-task" &&
    typeof data["childId"] === "number" &&
    typeof data["prompt"] === "string" &&
    typeof data["description"] === "string"
  )
    return ok({
      id,
      parentId,
      timestamp: new Date(
        typeof data["timestamp"] === "number" ? data["timestamp"] : 0,
      ).toISOString(),
      overflow: {},
      type: "event",
      eventType: "agent.subagent_task",
      subagentTask: {
        id: String(data["childId"]),
        prompt: data["prompt"],
        description: data["description"],
      },
    });
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
    // pi-durable stamps the summary message when it places the compaction.
    return ok({
      id,
      parentId,
      timestamp: new Date(entry.model?.[0]?.timestamp ?? 0).toISOString(),
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
  if (peer)
    return ok(
      systemInputEvent({
        id,
        parentId,
        timestamp: new Date(message.timestamp).toISOString(),
        overflow: {},
        ...peer,
        content: mapUserContent(message.content),
      }),
    );
  return mapPiEntry({
    id,
    parentId,
    timestamp: new Date(message.timestamp).toISOString(),
    type: "message",
    message: publicMessage(message),
  });
}

function projectNotification(
  entry: EntryRecord,
  parentId: string | null,
  sessionId: string,
): Result<HistoryRecord, MappingError> {
  const invalid = (): MappingError => ({
    type: "history_mapping_error",
    code: "mapping_failure",
    message: "Invalid subagent notification placement",
  });
  const message = entry.model?.[0];
  if (
    entry.kind !== "pi.user" ||
    entry.model?.length !== 1 ||
    message?.role !== "user" ||
    typeof message.content !== "string"
  )
    return err(invalid());
  const content = message.content;
  const parsed = Result.fromThrowable((): unknown => JSON.parse(content), invalid)();
  if (parsed.isErr()) return err(parsed.error);
  const payload = parsed.value;
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    !("agent_id" in payload) ||
    typeof payload.agent_id !== "string" ||
    !("description" in payload) ||
    typeof payload.description !== "string" ||
    !("message" in payload) ||
    typeof payload.message !== "string"
  )
    return err(invalid());
  return ok({
    id: `${sessionId}:${entry.id}`,
    parentId,
    timestamp: new Date(message.timestamp).toISOString(),
    type: "event",
    eventType: "pi.custom_message",
    custom: { customType: "subagent-notification", display: true },
    subagent: {
      kind: "notification",
      id: payload.agent_id,
      description: payload.description,
      message: payload.message,
    },
    overflow: {},
  });
}

export interface PublicEntryReceipt {
  readonly messageIds: readonly string[];
  readonly system?: unknown;
}

export function projectHistory(
  entries: readonly EntryRecord[],
  sessionId: string,
  receipts: ReadonlyMap<number, PublicEntryReceipt> = new Map(),
  notifications: ReadonlySet<number> = new Set(),
): Result<readonly HistoryRecord[], MappingError> {
  const records: HistoryRecord[] = [];
  for (const entry of entries) {
    const parentId = records.at(-1)?.id ?? null;
    const receipt = receipts.get(entry.id);
    const system = receipt?.system;
    if (
      system !== undefined &&
      (!Check(OrbMessageSystemSchema, system) ||
        (system.kind === "orb_message" && receipt?.messageIds.length !== 1))
    )
      return err({
        type: "history_mapping_error",
        code: "mapping_failure",
        message: "Invalid inbox system receipt",
      });
    const projected = notifications.has(entry.id)
      ? projectNotification(entry, parentId, sessionId)
      : projectEntry(
          entry,
          parentId,
          sessionId,
          receipt && system?.kind === "orb_message"
            ? { sender: { orbId: system.senderOrbId }, inboxMessageIds: [...receipt.messageIds] }
            : undefined,
        );
    if (projected.isErr()) return err(projected.error);
    if (!projected.value) continue;
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
                system?.kind === "sleep_wake" ? "pi-orb.sleep-wake" : "pi-orb.system-message",
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

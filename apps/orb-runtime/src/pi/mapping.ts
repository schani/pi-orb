import { err, ok, type Result } from "neverthrow";
import type {
  ContentBlock,
  HarnessSessionMetadata,
  HistoryRecord,
  JsonObject,
  JsonValue,
  MessageRecord,
} from "@pi-orb/protocol";

/**
 * Lossless Pi-entry → normalized-record mapping (DESIGN.md §9.2). Every
 * persisted entry maps one-to-one; a failure here fails the whole pull rather
 * than silently omitting an entry. The complete native entry always lands in
 * `overflow.native`.
 */

export interface MappingError {
  readonly type: "history_mapping_error";
  readonly code: "mapping_failure";
  readonly message: string;
}

const fail = (message: string): Result<never, MappingError> =>
  err({ type: "history_mapping_error", code: "mapping_failure", message });

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asJson(value: unknown): JsonValue {
  // Entries come from Pi's JSONL session file, so they are JSON-safe by
  // construction; this normalizes undefined away for exactness.
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

interface EntryIdentity {
  id: string;
  parentId: string | null;
  timestamp: string;
  overflow: JsonObject;
}

function identityOf(entry: Record<string, unknown>): Result<EntryIdentity, MappingError> {
  const { id, parentId, timestamp } = entry;
  if (typeof id !== "string" || id === "") {
    return fail(`entry has no usable id: ${JSON.stringify(entry).slice(0, 200)}`);
  }
  if (parentId !== null && typeof parentId !== "string") {
    return fail(`entry ${id} has invalid parentId`);
  }
  if (typeof timestamp !== "string") {
    return fail(`entry ${id} has no timestamp`);
  }
  return ok({
    id,
    parentId: parentId ?? null,
    timestamp,
    overflow: { native: asJson(entry) },
  });
}

function textBlock(text: string): ContentBlock {
  return { type: "text", text };
}

function mapUserContent(content: unknown): ContentBlock[] {
  if (typeof content === "string") return [textBlock(content)];
  if (!Array.isArray(content)) return [];
  const blocks: ContentBlock[] = [];
  for (const item of content) {
    if (!isRecordObject(item)) continue;
    if (item["type"] === "text" && typeof item["text"] === "string") {
      blocks.push(textBlock(item["text"]));
    } else if (item["type"] === "image") {
      blocks.push({
        type: "image",
        ...(typeof item["mimeType"] === "string" ? { mediaType: item["mimeType"] } : {}),
        ...(typeof item["data"] === "string" ? { data: item["data"] } : {}),
      });
    } else {
      blocks.push({ type: "other", contentType: String(item["type"]), data: asJson(item) });
    }
  }
  return blocks;
}

function mapAssistantContent(content: unknown): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  const blocks: ContentBlock[] = [];
  for (const item of content) {
    if (!isRecordObject(item)) continue;
    switch (item["type"]) {
      case "text":
        if (typeof item["text"] === "string") blocks.push(textBlock(item["text"]));
        break;
      case "thinking":
        blocks.push({
          type: "reasoning",
          text: typeof item["thinking"] === "string" ? item["thinking"] : "",
          ...(typeof item["redacted"] === "boolean" ? { redacted: item["redacted"] } : {}),
        });
        break;
      case "toolCall":
        blocks.push({
          type: "tool_call",
          callId: String(item["id"] ?? ""),
          name: String(item["name"] ?? ""),
          arguments: asJson(item["arguments"] ?? null),
        });
        break;
      default:
        blocks.push({ type: "other", contentType: String(item["type"]), data: asJson(item) });
    }
  }
  return blocks;
}

function mapMessageEntry(
  identity: EntryIdentity,
  message: Record<string, unknown>,
): Result<HistoryRecord, MappingError> {
  const role = message["role"];
  switch (role) {
    case "user":
      return ok({
        ...identity,
        type: "message",
        role: "user",
        content: mapUserContent(message["content"]),
      });
    case "assistant": {
      const usage = isRecordObject(message["usage"]) ? message["usage"] : undefined;
      const cost = usage !== undefined && isRecordObject(usage["cost"]) ? usage["cost"] : undefined;
      const usageNumber = (value: unknown): number | undefined =>
        typeof value === "number" ? value : undefined;
      const inputTokens = usageNumber(usage?.["input"]);
      const outputTokens = usageNumber(usage?.["output"]);
      const cacheReadTokens = usageNumber(usage?.["cacheRead"]);
      const cacheWriteTokens = usageNumber(usage?.["cacheWrite"]);
      const totalTokens = usageNumber(usage?.["totalTokens"]);
      const costUsd = usageNumber(cost?.["total"]);
      const record: MessageRecord = {
        ...identity,
        type: "message",
        role: "assistant",
        content: mapAssistantContent(message["content"]),
        ...(typeof message["model"] === "string"
          ? {
              model: {
                ...(typeof message["provider"] === "string"
                  ? { provider: message["provider"] }
                  : {}),
                id: message["model"],
              },
            }
          : {}),
        ...(usage !== undefined
          ? {
              usage: {
                ...(inputTokens !== undefined ? { inputTokens } : {}),
                ...(outputTokens !== undefined ? { outputTokens } : {}),
                ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
                ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
                ...(totalTokens !== undefined ? { totalTokens } : {}),
                ...(costUsd !== undefined ? { costUsd } : {}),
              },
            }
          : {}),
        ...(typeof message["stopReason"] === "string"
          ? { finishReason: message["stopReason"] }
          : {}),
      };
      return ok(record);
    }
    case "toolResult":
      return ok({
        ...identity,
        type: "message",
        role: "tool",
        content: [
          {
            type: "tool_result",
            callId: String(message["toolCallId"] ?? ""),
            content: mapUserContent(message["content"]).filter(
              (block) => block.type === "text" || block.type === "image" || block.type === "other",
            ),
            isError: message["isError"] === true,
          },
        ],
      });
    case "bashExecution":
      return ok({
        ...identity,
        type: "event",
        eventType: "pi.bash_execution",
        content: [
          textBlock(
            [message["command"], message["output"]]
              .filter((part): part is string => typeof part === "string")
              .join("\n"),
          ),
        ],
      });
    default:
      // An unknown message role becomes a generic event rather than
      // inventing a shared role (DESIGN.md §9.2).
      return ok({
        ...identity,
        type: "event",
        eventType: `pi.message.${String(role)}`,
      });
  }
}

/** Map one persisted Pi session entry to exactly one normalized record. */
export function mapPiEntry(entry: unknown): Result<HistoryRecord, MappingError> {
  if (!isRecordObject(entry)) {
    return fail(`entry is not an object: ${JSON.stringify(entry)?.slice(0, 200)}`);
  }
  const identityResult = identityOf(entry);
  if (identityResult.isErr()) return err(identityResult.error);
  const identity = identityResult.value;

  switch (entry["type"]) {
    case "message": {
      const message = entry["message"];
      if (!isRecordObject(message)) return fail(`message entry ${identity.id} has no message`);
      return mapMessageEntry(identity, message);
    }
    case "compaction":
      return ok({
        ...identity,
        type: "compaction",
        summary: [textBlock(typeof entry["summary"] === "string" ? entry["summary"] : "")],
      });
    case "thinking_level_change":
      return ok({ ...identity, type: "event", eventType: "pi.thinking_level_change" });
    case "model_change":
      return ok({ ...identity, type: "event", eventType: "pi.model_change" });
    case "branch_summary":
      return ok({
        ...identity,
        type: "event",
        eventType: "pi.branch_summary",
        content: [textBlock(typeof entry["summary"] === "string" ? entry["summary"] : "")],
      });
    case "custom":
      return ok({ ...identity, type: "event", eventType: "pi.custom" });
    case "custom_message":
      return ok({
        ...identity,
        type: "event",
        eventType: "pi.custom_message",
        content: mapUserContent(entry["content"]),
      });
    case "label":
      return ok({ ...identity, type: "event", eventType: "pi.label" });
    case "session_info":
      return ok({ ...identity, type: "event", eventType: "pi.session_info" });
    default:
      // Unknown future entry types preserve cursor continuity as events.
      return ok({
        ...identity,
        type: "event",
        eventType: `pi.${String(entry["type"])}`,
      });
  }
}

/** Map Pi's SessionHeader to session metadata (never a history record, §9.1). */
export function mapPiSessionHeader(header: unknown): Result<HarnessSessionMetadata, MappingError> {
  if (!isRecordObject(header) || typeof header["id"] !== "string") {
    return fail("session header has no id");
  }
  return ok({
    id: header["id"],
    ...(typeof header["timestamp"] === "string" ? { timestamp: header["timestamp"] } : {}),
    overflow: { native: asJson(header) },
  });
}

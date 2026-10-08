import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  type ContentBlock,
  type HistoryRecord,
  HistoryRecordSchema,
  isClaudeSessionTaskNotification,
  type JsonObject,
  JsonObjectSchema,
  type JsonValue,
} from "@pi-orb/protocol";
import { err, ok, Result } from "neverthrow";
import { Type } from "typebox";
import { Check } from "typebox/value";

const IndexSchema = Type.Object({
  records: Type.Array(HistoryRecordSchema),
  fingerprints: Type.Array(Type.String()),
});
const ProvenanceSchema = Type.Record(
  Type.String(),
  Type.Object({
    messageIds: Type.Array(Type.String()),
    operationId: Type.String(),
    system: Type.Optional(Type.Boolean()),
    compaction: Type.Optional(Type.Boolean()),
    boot: Type.Optional(Type.Boolean()),
  }),
);

export interface ClaudeHistoryError {
  readonly type: "claude_history_error";
  readonly message: string;
}
export interface Provenance {
  readonly messageIds: readonly string[];
  readonly operationId: string;
  readonly system?: boolean;
  readonly compaction?: boolean;
  readonly boot?: boolean;
}
export interface HistoryFiles {
  read(path: string): string | null;
  commit(path: string, text: string): void;
  sync(path: string): void;
}
export const nativeHistoryFiles: HistoryFiles = {
  read: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
  commit: (path, text) => {
    const temporary = `${path}.${randomUUID()}.new`;
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    const directory = openSync(dirname(path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  },
  sync: (path) => {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
};
const object = (value: JsonValue | undefined): JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
const text = (value: JsonValue | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

export function claudeContent(value: JsonValue | undefined): ContentBlock[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value)) return [];
  return value.map((item): ContentBlock => {
    const block = object(item);
    switch (block.type) {
      case "text":
        return { type: "text", text: text(block.text) ?? "" };
      case "thinking":
        return { type: "reasoning", text: text(block.thinking) ?? "" };
      case "redacted_thinking":
        return { type: "reasoning", text: "", redacted: true };
      case "image": {
        const source = object(block.source);
        const mediaType = text(source.media_type),
          data = text(source.data),
          url = text(source.url);
        return {
          type: "image",
          ...(mediaType === undefined ? {} : { mediaType }),
          ...(data === undefined ? {} : { data }),
          ...(url === undefined ? {} : { url }),
        };
      }
      case "tool_use":
        return {
          type: "tool_call",
          callId: text(block.id) ?? "",
          name: text(block.name) ?? "",
          arguments: block.input ?? {},
        };
      case "tool_result":
        return {
          type: "tool_result",
          callId: text(block.tool_use_id) ?? "",
          content: claudeContent(block.content).filter(
            (item): item is Exclude<ContentBlock, { type: "tool_result" }> =>
              item.type !== "tool_result",
          ),
          ...(typeof block.is_error === "boolean" ? { isError: block.is_error } : {}),
        };
      default:
        return { type: "other", contentType: text(block.type) ?? "unknown", data: item };
    }
  });
}

/** Reads only the root native file. The index fixes presentation identity; it is never a resume store. */
export class ClaudeHistory {
  private records: HistoryRecord[] = [];
  private fingerprints: string[] = [];
  private provenance: Record<string, Provenance> = {};
  private readonly indexPath: string;
  private readonly provenancePath: string;
  private loadError: ClaudeHistoryError | null = null;
  private readonly session: string;
  private readonly timestamp: string;
  private readonly files: HistoryFiles;
  constructor(
    dir: string,
    session: string,
    timestamp: string,
    files: HistoryFiles = nativeHistoryFiles,
  ) {
    this.session = session;
    this.timestamp = timestamp;
    this.files = files;
    this.indexPath = join(dir, "index.json");
    this.provenancePath = join(dir, "provenance.json");
    const loaded = Result.fromThrowable(
      () => {
        if (files === nativeHistoryFiles) mkdirSync(dir, { recursive: true, mode: 0o700 });
        const saved = files.read(this.indexPath);
        if (saved !== null) {
          const value: unknown = JSON.parse(saved);
          if (!Check(IndexSchema, value)) {
            this.loadError = {
              type: "claude_history_error",
              message: "Malformed Claude history index.",
            };
            return;
          }
          this.records = value.records;
          this.fingerprints = value.fingerprints;
        }
        const provenance = files.read(this.provenancePath);
        if (provenance !== null) {
          const value: unknown = JSON.parse(provenance);
          if (!Check(ProvenanceSchema, value)) {
            this.loadError = {
              type: "claude_history_error",
              message: "Malformed Claude provenance index.",
            };
            return;
          }
          this.provenance = value;
        }
      },
      (): ClaudeHistoryError => ({
        type: "claude_history_error",
        message: "Cannot load Claude history index.",
      }),
    )();
    if (loaded.isErr()) this.loadError = loaded.error;
  }
  get view(): readonly HistoryRecord[] {
    return this.records;
  }
  correlation(uuid: string): Provenance | undefined {
    return this.provenance[uuid];
  }
  appendPlatform(record: HistoryRecord): Result<void, ClaudeHistoryError> {
    if (this.loadError !== null) return err(this.loadError);
    if (!Check(HistoryRecordSchema, record))
      return err({ type: "claude_history_error", message: "Invalid Claude platform record." });
    const existing = this.records.find((item) => item.id === record.id);
    if (existing !== undefined)
      return JSON.stringify(existing) === JSON.stringify(record)
        ? ok(undefined)
        : err({ type: "claude_history_error", message: "Platform record identity conflicts." });
    const next = [...this.records, record];
    return Result.fromThrowable(
      () => {
        this.files.commit(
          this.indexPath,
          JSON.stringify({ records: next, fingerprints: this.fingerprints }),
        );
        this.records = next;
      },
      (): ClaudeHistoryError => ({
        type: "claude_history_error",
        message: "Cannot commit Claude platform record.",
      }),
    )();
  }
  correlate(uuid: string, provenance: Provenance): Result<void, ClaudeHistoryError> {
    if (this.loadError !== null) return err(this.loadError);
    const existing = this.provenance[uuid];
    if (existing !== undefined)
      return JSON.stringify(existing) === JSON.stringify(provenance)
        ? ok(undefined)
        : err({ type: "claude_history_error", message: "Claude input provenance conflicts." });
    const next = { ...this.provenance, [uuid]: provenance };
    return Result.fromThrowable(
      () => {
        this.files.commit(this.provenancePath, JSON.stringify(next));
        this.provenance = next;
      },
      (): ClaudeHistoryError => ({
        type: "claude_history_error",
        message: "Cannot commit Claude input provenance.",
      }),
    )();
  }
  scan(path: string | null): Result<readonly HistoryRecord[], ClaudeHistoryError> {
    if (this.loadError !== null) return err(this.loadError);
    return Result.fromThrowable(
      () => {
        if (path === null) return null;
        const source = this.files.read(path);
        if (source === null) return null;
        this.files.sync(path);
        return source
          .slice(0, source.lastIndexOf("\n") + 1)
          .split("\n")
          .filter(Boolean);
      },
      (): ClaudeHistoryError => ({
        type: "claude_history_error",
        message: "Cannot read durable Claude transcript.",
      }),
    )().andThen((lines): Result<readonly HistoryRecord[], ClaudeHistoryError> => {
      if (lines === null)
        return this.fingerprints.length === 0
          ? ok(this.records)
          : err({ type: "claude_history_error", message: "Native Claude transcript disappeared." });
      const fingerprints = lines.map((line) => createHash("sha256").update(line).digest("hex"));
      if (
        fingerprints.length < this.fingerprints.length ||
        this.fingerprints.some((hash, index) => fingerprints[index] !== hash)
      )
        return err({
          type: "claude_history_error",
          message: "Committed Claude transcript prefix changed; restart requires inspection.",
        });
      const next = [...this.records];
      for (let index = this.fingerprints.length; index < lines.length; index++) {
        const parsed: Result<JsonObject, ClaudeHistoryError> = Result.fromThrowable(
          (): JsonObject => JSON.parse(lines[index] ?? "") as JsonObject,
          (): ClaudeHistoryError => ({
            type: "claude_history_error",
            message: "Malformed native Claude transcript entry.",
          }),
        )();
        if (parsed.isErr()) return err(parsed.error);
        const native = parsed.value;
        if (!Check(JsonObjectSchema, native))
          return err({
            type: "claude_history_error",
            message: "Native Claude record is not an object.",
          });
        const id = text(native.uuid) ?? `claude:${this.session}:${index}:${fingerprints[index]}`;
        if (next.some((record) => record.id === id))
          return err({
            type: "claude_history_error",
            message: "Duplicate native Claude identity.",
          });
        const parentId =
          native.parentUuid === null ? null : (text(native.parentUuid) ?? next.at(-1)?.id ?? null);
        const base = { id, parentId, timestamp: text(native.timestamp) ?? this.timestamp };
        const message = object(native.message);
        const provenance = this.provenance[id];
        let compactOutput = false;
        if (
          native.type === "user" &&
          provenance === undefined &&
          message.role === "user" &&
          typeof message.content === "string" &&
          /^<local-command-stdout>[\s\S]*<\/local-command-stdout>$/.test(message.content)
        ) {
          const visited = new Set<string>();
          let ancestor = parentId;
          while (ancestor !== null && !visited.has(ancestor)) {
            visited.add(ancestor);
            if (this.provenance[ancestor]?.compaction === true) {
              compactOutput = true;
              break;
            }
            ancestor = next.find((item) => item.id === ancestor)?.parentId ?? null;
          }
        }
        let record: HistoryRecord;
        if (native.type === "user" && native.isCompactSummary === true) {
          record = {
            ...base,
            type: "compaction",
            summary: claudeContent(message.content),
            overflow: { native },
          };
        } else if (provenance?.compaction === true || compactOutput) {
          record = {
            ...base,
            type: "event",
            eventType: "claude.compact_command",
            overflow: { native: { type: native.type ?? "user", uuid: id } },
          };
        } else if (provenance === undefined && isClaudeSessionTaskNotification(native)) {
          record = {
            ...base,
            type: "event",
            eventType: "claude.task_notification",
            overflow: {
              native: {
                type: "user",
                uuid: id,
                origin: { kind: "task-notification", producer: "session-task" },
              },
            },
          };
        } else if (native.type === "user" && native.isMeta === true && provenance === undefined) {
          record = {
            ...base,
            type: "event",
            eventType: "claude.native_metadata",
            overflow: { native: { type: native.type, uuid: id, isMeta: true } },
          };
        } else if (native.type === "user" || native.type === "assistant") {
          const content = claudeContent(message.content);
          const role =
            native.type === "assistant"
              ? "assistant"
              : content.every((block) => block.type === "tool_result") && content.length > 0
                ? "tool"
                : "user";
          record = provenance?.boot
            ? {
                ...base,
                type: "event",
                eventType: "claude.boot_receipt",
                overflow: { operationId: provenance.operationId },
              }
            : provenance?.system
              ? {
                  ...base,
                  type: "event",
                  eventType: "claude.platform_message",
                  content,
                  inboxMessageIds: [...provenance.messageIds],
                  custom: { customType: "pi-orb.system-message", display: true },
                  overflow: { native },
                }
              : {
                  ...base,
                  type: "message",
                  role,
                  content,
                  overflow: { native },
                  ...(provenance === undefined
                    ? {}
                    : { inboxMessageIds: [...provenance.messageIds] }),
                  ...(typeof message.model === "string"
                    ? { model: { provider: "anthropic", id: message.model } }
                    : {}),
                  ...(typeof message.stop_reason === "string"
                    ? { finishReason: message.stop_reason }
                    : {}),
                };
        } else if (native.type === "system" && native.subtype === "compact_boundary") {
          record = {
            ...base,
            type: "event",
            eventType: "claude.compact_boundary",
            overflow: {
              native: {
                type: native.type,
                subtype: native.subtype,
                uuid: id,
                compactMetadata: native.compactMetadata ?? {},
              },
            },
          };
        } else {
          record = {
            ...base,
            type: "event",
            eventType: `claude.${text(native.type) ?? "unknown"}`,
            overflow: { native: { type: native.type ?? "unknown", uuid: id } },
          };
        }
        if (!Check(HistoryRecordSchema, record))
          return err({
            type: "claude_history_error",
            message: "Native Claude record does not satisfy history contract.",
          });
        next.push(record);
      }
      if (next.length === this.records.length) return ok(this.records);
      return Result.fromThrowable(
        () => {
          this.files.commit(this.indexPath, JSON.stringify({ records: next, fingerprints }));
          this.records = next;
          this.fingerprints = fingerprints;
          return this.records as readonly HistoryRecord[];
        },
        (): ClaudeHistoryError => ({
          type: "claude_history_error",
          message: "Cannot commit Claude history index.",
        }),
      )();
    });
  }
}

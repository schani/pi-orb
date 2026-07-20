import { type Static, Type } from "typebox";
import { JsonObjectSchema, JsonValueSchema } from "./json.ts";

const closed = { additionalProperties: false } as const;

export const HarnessSessionMetadataSchema = Type.Object(
  {
    id: Type.String(),
    timestamp: Type.Optional(Type.String()),
    /** Complete native session header/metadata. */
    overflow: JsonObjectSchema,
  },
  closed,
);
export type HarnessSessionMetadata = Static<typeof HarnessSessionMetadataSchema>;

export const MessageRoleSchema = Type.Union([
  Type.Literal("user"),
  Type.Literal("assistant"),
  Type.Literal("system"),
  Type.Literal("developer"),
  Type.Literal("tool"),
]);
export type MessageRole = Static<typeof MessageRoleSchema>;

const TextBlockSchema = Type.Object(
  {
    type: Type.Literal("text"),
    text: Type.String(),
    overflow: Type.Optional(JsonObjectSchema),
  },
  closed,
);

const ReasoningBlockSchema = Type.Object(
  {
    type: Type.Literal("reasoning"),
    text: Type.String(),
    redacted: Type.Optional(Type.Boolean()),
    overflow: Type.Optional(JsonObjectSchema),
  },
  closed,
);

const ImageBlockSchema = Type.Object(
  {
    type: Type.Literal("image"),
    mediaType: Type.Optional(Type.String()),
    data: Type.Optional(Type.String()),
    url: Type.Optional(Type.String()),
    overflow: Type.Optional(JsonObjectSchema),
  },
  closed,
);

const ToolCallBlockSchema = Type.Object(
  {
    type: Type.Literal("tool_call"),
    callId: Type.String(),
    name: Type.String(),
    arguments: JsonValueSchema,
    overflow: Type.Optional(JsonObjectSchema),
  },
  closed,
);

const OtherBlockSchema = Type.Object(
  {
    type: Type.Literal("other"),
    contentType: Type.String(),
    data: JsonValueSchema,
  },
  closed,
);

/**
 * `tool_result` nests further blocks; one level of nesting is typed exactly
 * and deeper levels are impossible in practice (tool results contain leaf
 * text/image blocks). The nested array reuses the non-recursive leaf union.
 */
const LeafBlockSchema = Type.Union([
  TextBlockSchema,
  ReasoningBlockSchema,
  ImageBlockSchema,
  ToolCallBlockSchema,
  OtherBlockSchema,
]);

const ToolResultBlockSchema = Type.Object(
  {
    type: Type.Literal("tool_result"),
    callId: Type.String(),
    content: Type.Array(LeafBlockSchema),
    isError: Type.Optional(Type.Boolean()),
    overflow: Type.Optional(JsonObjectSchema),
  },
  closed,
);

export const ContentBlockSchema = Type.Union([
  TextBlockSchema,
  ReasoningBlockSchema,
  ImageBlockSchema,
  ToolCallBlockSchema,
  ToolResultBlockSchema,
  OtherBlockSchema,
]);
export type ContentBlock = Static<typeof ContentBlockSchema>;

const recordBase = {
  id: Type.String(),
  parentId: Type.Union([Type.String(), Type.Null()]),
  timestamp: Type.String(),
  /**
   * Contains the complete original harness record and any data not
   * represented by normalized fields (lossless by construction).
   */
  overflow: JsonObjectSchema,
};

export const MessageRecordSchema = Type.Object(
  {
    ...recordBase,
    type: Type.Literal("message"),
    role: Type.Optional(MessageRoleSchema),
    content: Type.Array(ContentBlockSchema),
    model: Type.Optional(
      Type.Object(
        {
          provider: Type.Optional(Type.String()),
          id: Type.String(),
        },
        closed,
      ),
    ),
    usage: Type.Optional(
      Type.Object(
        {
          inputTokens: Type.Optional(Type.Number()),
          outputTokens: Type.Optional(Type.Number()),
          cacheReadTokens: Type.Optional(Type.Number()),
          cacheWriteTokens: Type.Optional(Type.Number()),
          totalTokens: Type.Optional(Type.Number()),
          costUsd: Type.Optional(Type.Number()),
        },
        closed,
      ),
    ),
    finishReason: Type.Optional(Type.String()),
  },
  closed,
);
export type MessageRecord = Static<typeof MessageRecordSchema>;

export const CompactionRecordSchema = Type.Object(
  {
    ...recordBase,
    type: Type.Literal("compaction"),
    summary: Type.Array(ContentBlockSchema),
  },
  closed,
);
export type CompactionRecord = Static<typeof CompactionRecordSchema>;

export const EventRecordSchema = Type.Object(
  {
    ...recordBase,
    type: Type.Literal("event"),
    eventType: Type.String(),
    content: Type.Optional(Type.Array(ContentBlockSchema)),
  },
  closed,
);
export type EventRecord = Static<typeof EventRecordSchema>;

export const HistoryRecordSchema = Type.Union([
  MessageRecordSchema,
  CompactionRecordSchema,
  EventRecordSchema,
]);
export type HistoryRecord = Static<typeof HistoryRecordSchema>;

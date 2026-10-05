import { type Static, Type } from "typebox";
import {
  ActivityHeadlineContext,
  activityCallEligible,
  activityResultEligible,
} from "./activity-headline.ts";
import { capHeadline } from "./headline.ts";
import { type ContentBlock, type HistoryRecord, NestedCallsSchema } from "./history.ts";
import { JsonValueSchema } from "./json.ts";
import { reasoningHeadline } from "./reasoning-headline.ts";

export { capHeadline } from "./headline.ts";

const closed = { additionalProperties: false } as const;
const text = Type.Object({ type: Type.Literal("text"), text: Type.String() }, closed);
const reasoning = Type.Object(
  {
    type: Type.Literal("reasoning"),
    headline: Type.String(),
    detailKey: Type.String(),
    redacted: Type.Optional(Type.Boolean()),
  },
  closed,
);
const image = Type.Object(
  {
    type: Type.Literal("image"),
    detailKey: Type.String(),
    mediaType: Type.Optional(Type.String()),
  },
  closed,
);
const call = Type.Object(
  {
    type: Type.Literal("tool_call"),
    callId: Type.String(),
    name: Type.String(),
    headline: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    detailKey: Type.String(),
    targetId: Type.Optional(Type.String()),
    offset: Type.Optional(Type.Number()),
    limit: Type.Optional(Type.Number()),
  },
  closed,
);
const result = Type.Object(
  {
    type: Type.Literal("tool_result"),
    callId: Type.String(),
    isError: Type.Optional(Type.Boolean()),
    headline: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    hasImages: Type.Boolean(),
    detailKey: Type.String(),
    added: Type.Optional(Type.Number()),
    removed: Type.Optional(Type.Number()),
  },
  closed,
);
const other = Type.Object({ type: Type.Literal("other"), contentType: Type.String() }, closed);
export const DisplayBlockSchema = Type.Union([text, reasoning, image, call, result, other]);
export type DisplayBlock = Static<typeof DisplayBlockSchema>;
const base = {
  id: Type.String(),
  parentId: Type.Union([Type.String(), Type.Null()]),
  timestamp: Type.String(),
};
const message = Type.Object(
  {
    ...base,
    type: Type.Literal("message"),
    role: Type.Optional(Type.String()),
    content: Type.Array(DisplayBlockSchema),
    model: Type.Optional(Type.Object({ provider: Type.Optional(Type.String()) }, closed)),
    finishReason: Type.Optional(Type.String()),
    inboxMessageIds: Type.Optional(Type.Array(Type.String())),
    failure: Type.Optional(
      Type.Object({ message: Type.String(), providerTransportFailure: Type.Boolean() }, closed),
    ),
  },
  closed,
);
const subagent = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("notification"),
      Type.Literal("update"),
      Type.Literal("workspace_notice"),
    ]),
    id: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    status: Type.Optional(Type.String()),
    headline: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    detailKey: Type.String(),
  },
  closed,
);
const event = Type.Object(
  {
    ...base,
    type: Type.Literal("event"),
    eventType: Type.String(),
    content: Type.Optional(Type.Array(DisplayBlockSchema)),
    custom: Type.Optional(
      Type.Object({ customType: Type.String(), display: Type.Boolean() }, closed),
    ),
    subagent: Type.Optional(subagent),
    alert: Type.Optional(Type.Object({ message: Type.String(), requestId: Type.String() }, closed)),
    inboxMessageIds: Type.Optional(Type.Array(Type.String())),
  },
  closed,
);
const compaction = Type.Object(
  { ...base, type: Type.Literal("compaction"), detailKey: Type.String() },
  closed,
);
/** Browser-only ordered identity and visible rows; never substitute for durable HistoryRecord. */
export const DisplayRecordSchema = Type.Union([message, event, compaction]);
export type DisplayRecord = Static<typeof DisplayRecordSchema>;
export const DisplayHistoryViewSchema = Type.Object(
  {
    orbId: Type.String(),
    session: Type.Union([
      Type.Object({ id: Type.String(), timestamp: Type.Optional(Type.String()) }, closed),
      Type.Null(),
    ]),
    records: Type.Array(DisplayRecordSchema),
    cursor: Type.Union([Type.String(), Type.Null()]),
    headId: Type.Union([Type.String(), Type.Null()]),
  },
  closed,
);
export type DisplayHistoryView = Static<typeof DisplayHistoryViewSchema>;

export const DisplayDetailLeafSchema = Type.Union([
  text,
  Type.Object(
    {
      type: Type.Literal("image"),
      mediaType: Type.Optional(Type.String()),
      imageRef: Type.Optional(Type.String()),
      url: Type.Optional(Type.String()),
    },
    closed,
  ),
]);
export const DisplayDetailBodySchema = Type.Union([
  Type.Object({ type: Type.Literal("reasoning"), text: Type.String() }, closed),
  Type.Object({ type: Type.Literal("tool_call"), arguments: JsonValueSchema }, closed),
  Type.Object(
    {
      type: Type.Literal("tool_result"),
      content: Type.Array(DisplayDetailLeafSchema),
      nestedCalls: Type.Optional(NestedCallsSchema),
    },
    closed,
  ),
  Type.Object(
    {
      type: Type.Literal("image"),
      mediaType: Type.Optional(Type.String()),
      imageRef: Type.Optional(Type.String()),
      url: Type.Optional(Type.String()),
    },
    closed,
  ),
  Type.Object({ type: Type.Literal("compaction"), text: Type.String() }, closed),
  Type.Object(
    {
      type: Type.Literal("subagent"),
      message: Type.Optional(Type.String()),
      notice: Type.Optional(Type.String()),
      error: Type.Optional(Type.String()),
      resultPreview: Type.Optional(Type.String()),
      durationMs: Type.Optional(Type.Number()),
    },
    closed,
  ),
]);
export type DisplayDetailBody = Static<typeof DisplayDetailBodySchema>;
export const CommittedDisplayDetailSchema = Type.Object(
  {
    v: Type.Literal(1),
    sessionId: Type.String(),
    recordId: Type.String(),
    detailKey: Type.String(),
    state: Type.Literal("committed"),
    body: DisplayDetailBodySchema,
  },
  closed,
);
export type CommittedDisplayDetail = Static<typeof CommittedDisplayDetailSchema>;
export const LiveDisplayDetailSchema = Type.Object(
  {
    v: Type.Literal(1),
    sessionId: Type.String(),
    operationId: Type.String(),
    blockId: Type.String(),
    state: Type.Union([
      Type.Literal("running"),
      Type.Literal("completed"),
      Type.Literal("unavailable"),
    ]),
    body: Type.Optional(
      Type.Union([
        Type.Object({ type: Type.Literal("reasoning"), text: Type.String() }, closed),
        Type.Object(
          {
            type: Type.Literal("tool_result"),
            arguments: Type.Optional(JsonValueSchema),
            content: Type.Array(DisplayDetailLeafSchema),
          },
          closed,
        ),
      ]),
    ),
  },
  closed,
);
export type LiveDisplayDetail = Static<typeof LiveDisplayDetailSchema>;

function headline(block: Extract<ContentBlock, { type: "tool_call" }>): string | null | undefined {
  if (activityCallEligible(block)) return null;
  const args = block.arguments;
  if (typeof args === "object" && args !== null && !Array.isArray(args)) {
    const value =
      block.name === "bash"
        ? args.command
        : ["read", "edit", "write"].includes(block.name)
          ? args.path
          : undefined;
    if (typeof value === "string") return capHeadline(value);
  }
  return ["bash", "read", "edit", "write"].includes(block.name) ? "" : undefined;
}

function targetId(path: string): string {
  // Two independent 64-bit lanes avoid exposing an uncapped path merely to count distinct targets.
  let a = 0xcbf29ce484222325n;
  let b = 0x84222325cbf29ce4n;
  for (const byte of new TextEncoder().encode(path)) {
    a = BigInt.asUintN(64, (a ^ BigInt(byte)) * 0x100000001b3n);
    b = BigInt.asUintN(64, (b ^ BigInt(byte)) * 0x100000001b3n);
  }
  return `${a.toString(16).padStart(16, "0")}${b.toString(16).padStart(16, "0")}`;
}

function diffStats(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
}

function remoteImageUrl(value: string | undefined): string | undefined {
  return value !== undefined && /^https?:\/\/[^/@?#\s]+(?:[/?#]|$)/i.test(value)
    ? value
    : undefined;
}

function projectBlock(block: ContentBlock, key: string): DisplayBlock {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "reasoning":
      return {
        type: "reasoning",
        headline: reasoningHeadline(block.text, block.redacted),
        detailKey: key,
        ...(block.redacted === undefined ? {} : { redacted: block.redacted }),
      };
    case "image":
      return {
        type: "image",
        detailKey: key,
        ...(block.mediaType === undefined ? {} : { mediaType: block.mediaType }),
      };
    case "tool_call": {
      const args =
        typeof block.arguments === "object" &&
        block.arguments !== null &&
        !Array.isArray(block.arguments)
          ? block.arguments
          : null;
      const path = args?.path;
      const selectedHeadline = headline(block);
      return {
        type: "tool_call",
        callId: block.callId,
        name: block.name,
        ...(selectedHeadline === undefined ? {} : { headline: selectedHeadline }),
        detailKey: key,
        ...(typeof path === "string" ? { targetId: targetId(path) } : {}),
        ...(typeof args?.offset === "number" ? { offset: args.offset } : {}),
        ...(typeof args?.limit === "number" ? { limit: args.limit } : {}),
      };
    }
    case "tool_result":
      return {
        type: "tool_result",
        callId: block.callId,
        ...(block.isError === undefined ? {} : { isError: block.isError }),
        hasImages: block.content.some((item) => item.type === "image"),
        detailKey: key,
        ...(block.patch === undefined ? {} : diffStats(block.patch)),
      };
    case "other":
      return { type: "other", contentType: block.contentType };
  }
}

function projectBlocks(blocks: readonly ContentBlock[], recordId: string): DisplayBlock[] {
  return blocks.flatMap((block, index) =>
    block.type === "reasoning" && block.redacted !== true && block.text.trim() === ""
      ? []
      : [projectBlock(block, `${recordId}:${index}`)],
  );
}

export function projectDisplayRecord(record: HistoryRecord): DisplayRecord {
  const base = {
    id: record.id,
    parentId: record.parentId,
    timestamp: record.timestamp,
  };
  switch (record.type) {
    case "message":
      return {
        ...base,
        type: "message",
        ...(record.role === undefined ? {} : { role: record.role }),
        content: projectBlocks(record.content, record.id),
        ...(record.model?.provider === undefined
          ? {}
          : { model: { provider: record.model.provider } }),
        ...(record.finishReason === undefined ? {} : { finishReason: record.finishReason }),
        ...(record.inboxMessageIds === undefined
          ? {}
          : { inboxMessageIds: record.inboxMessageIds }),
        ...(record.failure === undefined
          ? {}
          : {
              failure: {
                message: record.failure.message,
                providerTransportFailure: record.failure.diagnostics.includes(
                  "provider_transport_failure",
                ),
              },
            }),
      };
    case "compaction":
      return { ...base, type: "compaction", detailKey: `${record.id}:summary` };
    case "event":
      return {
        ...base,
        type: "event",
        eventType: record.eventType,
        ...(record.content === undefined ||
        record.subagent !== undefined ||
        (record.custom?.display !== true && record.eventType !== "agent.settings_fallback")
          ? {}
          : {
              content: projectBlocks(record.content, record.id),
            }),
        ...(record.custom === undefined ? {} : { custom: record.custom }),
        ...(record.subagent === undefined
          ? {}
          : {
              subagent: {
                kind: record.subagent.kind,
                ...(record.subagent.kind === "notification" ? { headline: null } : {}),
                detailKey: `${record.id}:subagent`,
                ...(record.subagent.id === undefined ? {} : { id: record.subagent.id }),
                ...(record.subagent.description === undefined
                  ? {}
                  : { description: capHeadline(record.subagent.description) }),
                ...(record.subagent.status === undefined
                  ? {}
                  : { status: capHeadline(record.subagent.status) }),
              },
            }),
        ...(record.alert === undefined ? {} : { alert: record.alert }),
        ...(record.inboxMessageIds === undefined
          ? {}
          : { inboxMessageIds: record.inboxMessageIds }),
      };
  }
}

/** Incremental ordered projection; seed with the prefix before emitting a cursor suffix. */
export function createDisplayRecordProjector(): (record: HistoryRecord) => DisplayRecord {
  const context = new ActivityHeadlineContext();
  return (record) => {
    const matches = context.visit(record);
    const display = projectDisplayRecord(record);
    if (record.type === "message" && display.type === "message") {
      display.content = display.content.map((block) => {
        if (block.type !== "tool_result") return block;
        const index = Number(block.detailKey.slice(record.id.length + 1));
        const source = record.content[index];
        return source?.type === "tool_result" && activityResultEligible(source, matches.get(index))
          ? { ...block, headline: null }
          : block;
      });
    }
    return display;
  };
}

export function projectDisplayRecords(records: readonly HistoryRecord[]): DisplayRecord[] {
  return records.map(createDisplayRecordProjector());
}

/** Returns only renderable detail. Null means the manifest key does not exist. */
export function projectRecordDetail(
  record: HistoryRecord,
  detailKey: string,
): DisplayDetailBody | null {
  if (detailKey === `${record.id}:summary` && record.type === "compaction")
    return {
      type: "compaction",
      text: record.summary
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
    };
  if (
    detailKey === `${record.id}:subagent` &&
    record.type === "event" &&
    record.subagent !== undefined
  ) {
    const { kind, message, notice, error, resultPreview, durationMs } = record.subagent;
    const visible = (value: string | undefined) =>
      value !== undefined && value.trim() !== "" ? value : undefined;
    const body: Extract<DisplayDetailBody, { type: "subagent" }> = {
      type: "subagent",
    };
    if (kind === "update") {
      const selected = visible(message);
      if (selected !== undefined) body.message = selected;
    } else if (kind === "workspace_notice") {
      const selected = visible(notice);
      if (selected !== undefined) body.notice = selected;
    } else {
      const selectedError = visible(error);
      if (selectedError !== undefined) body.error = selectedError;
      else {
        const selectedPreview = visible(resultPreview);
        if (selectedPreview !== undefined) body.resultPreview = selectedPreview;
      }
    }
    if (durationMs !== undefined && durationMs >= 0) body.durationMs = durationMs;
    return body;
  }
  if (!detailKey.startsWith(`${record.id}:`)) return null;
  const suffix = detailKey.slice(record.id.length + 1);
  if (!/^(0|[1-9][0-9]*)$/.test(suffix)) return null;
  const index = Number(suffix);
  const blocks =
    record.type === "compaction"
      ? record.summary
      : record.type === "message"
        ? record.content
        : record.content;
  const block = blocks?.[index];
  if (block === undefined) return null;
  switch (block.type) {
    case "reasoning":
      return { type: "reasoning", text: block.text };
    case "tool_call": {
      const args = block.arguments;
      return {
        type: "tool_call",
        arguments:
          block.name === "bash"
            ? typeof args === "object" &&
              args !== null &&
              !Array.isArray(args) &&
              typeof args.command === "string"
              ? { command: args.command }
              : {}
            : args,
      };
    }
    case "tool_result":
      return {
        type: "tool_result",
        ...(block.nestedCalls === undefined ? {} : { nestedCalls: block.nestedCalls }),
        content: block.content
          .map((child, childIndex) =>
            child.type === "text"
              ? { type: "text" as const, text: child.text }
              : child.type === "image"
                ? {
                    type: "image" as const,
                    ...(child.mediaType === undefined ? {} : { mediaType: child.mediaType }),
                    ...(child.data === undefined ? {} : { imageRef: `${detailKey}:${childIndex}` }),
                    ...(child.url !== undefined && remoteImageUrl(child.url) !== undefined
                      ? { url: child.url }
                      : {}),
                  }
                : null,
          )
          .filter((child) => child !== null),
      };
    case "image":
      return {
        type: "image",
        ...(block.mediaType === undefined ? {} : { mediaType: block.mediaType }),
        ...(block.data === undefined ? {} : { imageRef: `${detailKey}:0` }),
        ...(block.url !== undefined && remoteImageUrl(block.url) !== undefined
          ? { url: block.url }
          : {}),
      };
    default:
      return null;
  }
}

export function projectRecordImage(
  record: HistoryRecord,
  detailKey: string,
  imageIndex: number,
): { mediaType: string; data: string } | null {
  const detail = projectRecordDetail(record, detailKey);
  if (detail === null || (detail.type !== "image" && detail.type !== "tool_result")) return null;
  const index = Number(detailKey.slice(record.id.length + 1));
  const blocks =
    record.type === "compaction"
      ? record.summary
      : record.type === "message"
        ? record.content
        : record.content;
  const block = blocks?.[index];
  const image =
    block?.type === "image" && imageIndex === 0
      ? block
      : block?.type === "tool_result"
        ? block.content[imageIndex]
        : undefined;
  return image?.type === "image" && image.data !== undefined
    ? { mediaType: image.mediaType ?? "image/png", data: image.data }
    : null;
}

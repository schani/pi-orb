import type { HistoryRecord, TimelineRow, TurnTimeline } from "@pi-orb/protocol";

/** A stopped Pi orb whose turns open into waterfalls (docs/web-ui.md "Pi transcript timeline"). */
export const TIMELINE_ORB_ID = "frontend-timeline";
/** This turn's reads fail until `POST .../fixture-timeline-heal`, so failure and Retry are observable. */
export const TIMELINE_RETRY_TURN = "timeline-u2";
/** This turn's band exists but the endpoint answers 404. */
export const TIMELINE_MISSING_TURN = "timeline-u3";

const S = 1000;

function base(createdAt: string): number {
  return Date.parse(createdAt) - 60 * 60 * S;
}

type MessageRecord = Extract<HistoryRecord, { type: "message" }>;

function record(
  id: string,
  at: number,
  fields: Omit<MessageRecord, "id" | "parentId" | "timestamp" | "type" | "overflow">,
): MessageRecord {
  return {
    id,
    parentId: null,
    timestamp: new Date(at).toISOString(),
    type: "message",
    overflow: {},
    ...fields,
  };
}

const user = (id: string, at: number, text: string) =>
  record(id, at, {
    role: "user",
    inboxMessageIds: [`inbox-${id}`],
    content: [{ type: "text", text }],
  });

const assistant = (
  id: string,
  at: number,
  finishReason: string,
  content: MessageRecord["content"],
) =>
  record(id, at, {
    role: "assistant",
    model: { provider: "openai-codex", id: "gpt-6-astra" },
    finishReason,
    content,
  });

const result = (id: string, at: number, callId: string, text: string, isError = false) =>
  record(id, at, {
    role: "tool",
    content: [{ type: "tool_result", callId, content: [{ type: "text", text }], isError }],
  });

export function timelineFixtureRecords(createdAt: string): HistoryRecord[] {
  const t = base(createdAt);
  const records: HistoryRecord[] = [
    user("timeline-u1", t, "Chart heatmap render time against cell count for the last day."),
    assistant("timeline-a1", t + 0.1 * S, "toolUse", [
      { type: "text", text: "Querying render timings.\nThen charting them against cell counts." },
      { type: "tool_call", callId: "timeline-c1", name: "codemode", arguments: { code: "…" } },
    ]),
    result("timeline-t1", t + 13.1 * S, "timeline-c1", "4 calls · chart"),
    user("timeline-steer", t + 13.5 * S, "Cover the 320px viewport too."),
    assistant("timeline-a3", t + 22 * S, "toolUse", [
      { type: "text", text: "Applying the floor to both charts." },
      {
        type: "tool_call",
        callId: "timeline-c2",
        name: "edit",
        arguments: { path: "apps/web/src/chart-spec.ts" },
      },
      {
        type: "tool_call",
        callId: "timeline-c3",
        name: "bash",
        arguments: { command: "npm run test:browser -- charts.spec.ts" },
      },
    ]),
    result("timeline-t2", t + 31.4 * S, "timeline-c2", "+7 −3"),
    result("timeline-t3", t + 52 * S, "timeline-c3", "1 failed", true),
    {
      id: "timeline-k1",
      parentId: null,
      timestamp: new Date(t + 58 * S).toISOString(),
      type: "compaction",
      summary: [{ type: "text", text: "Heatmap zero-row investigation so far." }],
      overflow: {},
    },
    assistant("timeline-a4", t + 58.1 * S, "stop", [
      { type: "text", text: "Done; the zero rows render now." },
    ]),
    user("timeline-u2", t + 120 * S, "Retry the phone run."),
    {
      ...assistant("timeline-a5", t + 120.1 * S, "error", []),
      failure: { message: "503 upstream connect error", diagnostics: [] },
    },
    user("timeline-u3", t + 180 * S, "One more."),
    assistant("timeline-a6", t + 180.1 * S, "stop", [{ type: "text", text: "Sure." }]),
  ];
  return records.map((record, index) => ({ ...record, parentId: records[index - 1]?.id ?? null }));
}

const model = (
  id: string,
  start: number,
  end: number,
  fields: Partial<Extract<TimelineRow, { kind: "model" }>> = {},
): TimelineRow => ({
  kind: "model",
  id,
  start,
  end,
  use: "root",
  model: "gpt-6-astra",
  input: 1_200,
  output: 420,
  cacheRead: 38_000,
  cacheWrite: 0,
  costUsd: 0.021,
  stop: "stop",
  ...fields,
});

const tool = (
  id: string,
  start: number,
  end: number,
  name: string,
  fields: Partial<Extract<TimelineRow, { kind: "tool" }>> = {},
): TimelineRow => ({ kind: "tool", id, start, end, name, nested: false, status: "ok", ...fields });

/** `t` is the time of the first fixture record. */
export function timelineFixture(t: number, turnId: string): TurnTimeline | null {
  const at = (seconds: number) => Math.round(t + seconds * S);
  if (turnId === "timeline-u1")
    return {
      start: t,
      rows: [
        model("timeline-a1", at(0.1), at(4.2), {
          ttftMs: 900,
          thinkingMs: 2_400,
          stop: "toolUse",
          said: "Querying render timings.\nThen charting them against cell counts.",
        }),
        tool("timeline-c1", at(4.3), at(13.1), "codemode", { calls: 4, result: "4 calls · chart" }),
        tool("timeline-c1:1", at(4.4), at(5), "mcp__datadog__search_metrics", { nested: true }),
        tool("timeline-c1:2", at(5.1), at(9.8), "mcp__datadog__query_metrics", { nested: true }),
        tool("timeline-c1:3", at(5.1), at(8.6), "mcp__datadog__query_metrics", { nested: true }),
        tool("timeline-c1:4", at(12.9), at(13), "chart", { nested: true }),
        {
          kind: "marker",
          id: "timeline-steer",
          start: at(13.5),
          marker: "steering",
          text: "Cover the 320px viewport too.",
        },
        model("timeline-a3", at(22), at(31), {
          ttftMs: 800,
          thinkingMs: 3_000,
          stop: "toolUse",
          said: "Applying the floor to both charts.",
        }),
        tool("timeline-c2", at(31.1), at(31.4), "edit", {
          arg: "apps/web/src/chart-spec.ts",
          result: "+7 −3",
        }),
        tool("timeline-c3", at(31.5), at(52), "bash", {
          arg: "npm run test:browser -- charts.spec.ts",
          status: "error",
          result: "1 failed",
        }),
        model("timeline-k1", at(52.2), at(58), { use: "compaction", stop: "stop" }),
        model("timeline-a4", at(58.1), at(66), {
          ttftMs: 1_200,
          said: "Done; the zero rows render now.",
        }),
        model("call:0", at(66.2), at(67.5), { use: "turn_summary", model: "gpt-6-luna" }),
      ],
    };
  if (turnId === TIMELINE_RETRY_TURN)
    return {
      start: at(120),
      rows: [
        model("timeline-a5", at(120.1), at(128), {
          ttftMs: 1_100,
          stop: "error",
          error: "503 upstream connect error",
          output: 0,
        }),
      ],
    };
  return null;
}

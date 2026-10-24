import type { HistoryRecord, JsonObject, TimelineRow } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { makeOrbRow } from "../testkit/fixtures.ts";
import type { StoreError } from "./errors.ts";
import type { OrbRow } from "./orb.ts";
import {
  type RecordedModelCall,
  readTurnTimeline,
  type TurnCallQuery,
  type TurnTimelineDeps,
} from "./turn-timeline.ts";

const T = Date.UTC(2026, 9, 24, 12);
const iso = (offset: number) => new Date(T + offset).toISOString();
const task = new NoSimulationTask("turn timeline", false);

function user(id: string, offset: number, text = "Go."): HistoryRecord {
  return {
    id,
    parentId: null,
    timestamp: iso(offset),
    type: "message",
    role: "user",
    inboxMessageIds: [`inbox-${id}`],
    content: [{ type: "text", text }],
    overflow: {},
  };
}

function assistant(
  id: string,
  offset: number,
  options: {
    durationMs?: number;
    responseId?: string;
    stop?: string;
    content?: Extract<HistoryRecord, { type: "message" }>["content"];
    failure?: string;
  } = {},
): HistoryRecord {
  return {
    id,
    parentId: null,
    timestamp: iso(offset),
    type: "message",
    role: "assistant",
    model: { provider: "openai-codex", id: "gpt-6-astra" },
    usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 4000, costUsd: 0.01 },
    finishReason: options.stop ?? "stop",
    ...(options.failure === undefined
      ? {}
      : { failure: { message: options.failure, diagnostics: [] } }),
    content: options.content ?? [],
    overflow: {
      native: {
        type: "message",
        message: {
          role: "assistant",
          timestamp: T + offset,
          ...(options.durationMs === undefined ? {} : { durationMs: options.durationMs }),
          ...(options.responseId === undefined ? {} : { responseId: options.responseId }),
        },
      },
    },
  };
}

function call(callId: string, name: string, args: JsonObject = {}) {
  return { type: "tool_call" as const, callId, name, arguments: args };
}

function result(
  id: string,
  endOffset: number,
  callId: string,
  options: {
    durationMs?: number;
    text?: string;
    isError?: boolean;
    calls?: JsonObject[];
    omittedCalls?: number;
  } = {},
): HistoryRecord {
  return {
    id,
    parentId: null,
    timestamp: iso(endOffset),
    type: "message",
    role: "tool",
    content: [
      {
        type: "tool_result",
        callId,
        content: [{ type: "text", text: options.text ?? "ok" }],
        ...(options.isError === undefined ? {} : { isError: options.isError }),
      },
    ],
    overflow: {
      native: {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: callId,
          timestamp: T + endOffset,
          ...(options.durationMs === undefined ? {} : { durationMs: options.durationMs }),
          ...(options.calls === undefined
            ? {}
            : {
                details: {
                  calls: options.calls,
                  ...(options.omittedCalls === undefined
                    ? {}
                    : { omittedCalls: options.omittedCalls }),
                },
              }),
        },
      },
    },
  };
}

function event(
  id: string,
  offset: number,
  fields: Partial<Extract<HistoryRecord, { type: "event" }>>,
): HistoryRecord {
  return {
    id,
    parentId: null,
    timestamp: iso(offset),
    type: "event",
    eventType: "pi.custom_message",
    overflow: {},
    ...fields,
  };
}

function compaction(id: string, timestamp: string): HistoryRecord {
  return {
    id,
    parentId: null,
    timestamp,
    type: "compaction",
    summary: [{ type: "text", text: "Summary." }],
    overflow: {},
  };
}

function modelCall(overrides: Partial<RecordedModelCall> & { at: number }): RecordedModelCall {
  return {
    use: "root",
    provider: "openai-codex",
    model: "gpt-6-astra",
    outcome: "stop",
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheWrite: 0,
    ...overrides,
  };
}

function deps(
  records: readonly HistoryRecord[],
  calls: readonly RecordedModelCall[] = [],
  orb: OrbRow | null = makeOrbRow("orb", "project", "running"),
) {
  const readTurnCalls = vi.fn((_task: unknown, _orbId: string, _query: TurnCallQuery) =>
    okAsync<RecordedModelCall[], StoreError>([...calls]),
  );
  const value: TurnTimelineDeps = {
    store: {
      getOrb: () => okAsync(orb),
      readHistorySnapshot: () =>
        okAsync({ session: null, cursor: null, headId: null, records: [...records] }),
    },
    modelUsage: { readTurnCalls },
  };
  return { value, readTurnCalls };
}

async function rows(
  records: readonly HistoryRecord[],
  turnId: string,
  calls: readonly RecordedModelCall[] = [],
): Promise<TimelineRow[]> {
  return (await readTurnTimeline(task, deps(records, calls).value, "orb", turnId))._unsafeUnwrap()
    .rows;
}

describe("Pi turn timeline assembly", () => {
  it("joins root calls by response id and places tools at their measured start", async () => {
    const records = [
      user("u1", 0),
      assistant("a1", 100, {
        durationMs: 2000.4,
        responseId: "r1",
        stop: "toolUse",
        content: [call("c1", "bash", { command: "npm test\n--watch=false", timeout: 5 })],
      }),
      result("t1", 3000, "c1", { durationMs: 800, text: "\n  12 passed  \nmore" }),
      assistant("a2", 3100, {
        durationMs: 1000,
        responseId: "r2",
        content: [
          { type: "reasoning", text: "hidden" },
          { type: "text", text: "Done." },
          { type: "text", text: "All green." },
        ],
      }),
    ];
    const { value, readTurnCalls } = deps(records, [
      modelCall({ at: T + 2100, responseId: "r1", ttftMs: 400, thinkingMs: 1500 }),
      modelCall({ at: T + 4100, responseId: "r2", ttftMs: 300 }),
      modelCall({ at: T + 4100, responseId: "elsewhere", ttftMs: 1 }),
    ]);
    const timeline = (await readTurnTimeline(task, value, "orb", "u1"))._unsafeUnwrap();
    expect(readTurnCalls).toHaveBeenCalledWith(task, "orb", {
      responseIds: ["r1", "r2"],
      from: T,
      until: T + 4100 + 60_000,
    });
    expect(timeline).toEqual({
      start: T,
      rows: [
        {
          kind: "model",
          id: "a1",
          start: T + 100,
          end: T + 2100,
          use: "root",
          model: "gpt-6-astra",
          ttftMs: 400,
          thinkingMs: 1500,
          input: 120,
          output: 30,
          cacheRead: 4000,
          costUsd: 0.01,
          stop: "toolUse",
        },
        {
          kind: "tool",
          id: "c1",
          start: T + 2200,
          end: T + 3000,
          name: "bash",
          arg: "npm test",
          nested: false,
          status: "ok",
          result: "12 passed",
        },
        {
          kind: "model",
          id: "a2",
          start: T + 3100,
          end: T + 4100,
          use: "root",
          model: "gpt-6-astra",
          ttftMs: 300,
          input: 120,
          output: 30,
          cacheRead: 4000,
          costUsd: 0.01,
          stop: "stop",
          said: "Done.\nAll green.",
        },
      ],
    });
  });

  it("ends the turn at the next turn-starting band and keeps steering inside it", async () => {
    const records = [
      user("u1", 0),
      assistant("a1", 10, { durationMs: 10, stop: "toolUse", content: [call("c1", "read")] }),
      result("t1", 40, "c1", { durationMs: 5 }),
      user("steer", 45, "Also check the phone layout."),
      assistant("a2", 50, { durationMs: 10 }),
      user("u2", 1000),
      assistant("a3", 1010, { durationMs: 10 }),
    ];
    const first = deps(records);
    const timeline = (await readTurnTimeline(task, first.value, "orb", "u1"))._unsafeUnwrap();
    expect(timeline.rows.map((row) => row.id)).toEqual(["a1", "c1", "steer", "a2"]);
    expect(timeline.rows[2]).toEqual({
      kind: "marker",
      id: "steer",
      start: T + 45,
      marker: "steering",
      text: "Also check the phone layout.",
    });
    expect(first.readTurnCalls.mock.calls[0]?.[2]).toEqual({
      responseIds: [],
      from: T,
      until: T + 1000,
    });
    expect((await rows(records, "u2")).map((row) => row.id)).toEqual(["a3"]);
    for (const id of ["steer", "a1", "missing"])
      expect(
        (await readTurnTimeline(task, deps(records).value, "orb", id))._unsafeUnwrapErr(),
      ).toEqual({ type: "turn_missing" });
  });

  it("places other model calls by start and pairs compactions with their call", async () => {
    const records = [
      user("u1", 0),
      assistant("a1", 10, { durationMs: 100 }),
      compaction("k1", iso(4000)),
      compaction("k2", iso(6000)),
    ];
    expect(
      await rows(records, "u1", [
        modelCall({ at: T + 2500, use: "subagent", durationMs: 1000, ttftMs: 200 }),
        modelCall({ at: T + 3000, use: "compaction", outcome: "error", durationMs: 500 }),
        modelCall({ at: T + 3990, use: "compaction", durationMs: 1990, costUsd: 0.02 }),
        modelCall({ at: T + 5000, use: "turn_summary", model: "gpt-6-luna" }),
      ]),
    ).toEqual([
      expect.objectContaining({ id: "a1", start: T + 10 }),
      {
        kind: "model",
        id: "call:0",
        start: T + 1500,
        end: T + 2500,
        use: "subagent",
        model: "gpt-6-astra",
        ttftMs: 200,
        input: 1,
        output: 2,
        cacheRead: 3,
        cacheWrite: 0,
        stop: "stop",
      },
      {
        kind: "model",
        id: "k1",
        start: T + 2000,
        end: T + 3990,
        use: "compaction",
        model: "gpt-6-astra",
        input: 1,
        output: 2,
        cacheRead: 3,
        cacheWrite: 0,
        costUsd: 0.02,
        stop: "stop",
      },
      expect.objectContaining({ id: "call:1", start: T + 2500, use: "compaction", stop: "error" }),
      expect.objectContaining({
        id: "call:3",
        start: T + 5000,
        end: T + 5000,
        use: "turn_summary",
      }),
      { kind: "marker", id: "k2", start: T + 6000, marker: "compaction" },
    ]);
  });

  it("pairs a compaction whose ledger row was stamped after the summary was placed", async () => {
    // The ledger stamps `at` inside its insert transaction, which can commit after pi-durable places the summary.
    const records = [user("u1", 0), compaction("k1", iso(4000))];
    expect(
      await rows(records, "u1", [modelCall({ at: T + 4005, use: "compaction", durationMs: 2000 })]),
    ).toEqual([expect.objectContaining({ kind: "model", id: "k1", start: T + 2005 })]);
  });

  it("renders records from before 2026-10-24 without invented timing", async () => {
    const records = [
      user("u1", 0),
      assistant("a1", 10, { stop: "toolUse", content: [call("c1", "codemode", { code: "x" })] }),
      result("t1", 900, "c1", {
        calls: [
          { id: 1, name: "read", status: "ok", durationMs: 3, argumentKeys: ["path"] },
          { id: 2, name: "bash", status: "error", argumentKeys: [] },
        ],
      }),
      compaction("k1", new Date(0).toISOString()),
    ];
    expect(await rows(records, "u1")).toEqual([
      expect.objectContaining({ kind: "model", id: "a1", start: T + 10, end: T + 10 }),
      {
        kind: "tool",
        id: "c1",
        start: T + 10,
        end: T + 900,
        name: "codemode",
        nested: false,
        status: "ok",
        result: "ok",
        calls: 2,
      },
    ]);
  });

  it("lists code-mode calls under their parent at their persisted starts", async () => {
    const records = [
      user("u1", 0),
      assistant("a1", 10, {
        durationMs: 10,
        stop: "toolUse",
        content: [call("c1", "codemode", { code: "x" }), call("c2", "bash", { command: "ls" })],
      }),
      result("t1", 2000, "c1", {
        durationMs: 1900,
        isError: true,
        text: "Error: boom",
        omittedCalls: 70,
        calls: [
          { id: 2, name: "grep", status: "cancelled", startedAt: iso(1500), argumentKeys: [] },
          {
            id: 1,
            name: "read",
            status: "ok",
            startedAt: iso(300),
            durationMs: 40.6,
            argumentKeys: [],
          },
          { id: 3, name: "bash", status: "error", startedAt: iso(900), durationMs: 10 },
        ],
      }),
      result("t2", 700, "c2", { durationMs: 500 }),
    ];
    expect(
      (await rows(records, "u1")).map((row) =>
        row.kind === "tool"
          ? [row.id, row.start - T, row.end - T, row.nested, row.status, row.calls]
          : [row.id],
      ),
    ).toEqual([
      ["a1"],
      ["c1", 100, 2000, false, "error", 73],
      ["c1:1", 300, 341, true, "ok", undefined],
      ["c1:3", 900, 910, true, "error", undefined],
      ["c1:2", 1500, 1500, true, "cancelled", undefined],
      ["c2", 200, 700, false, "ok", undefined],
    ]);
  });

  it("marks alerts, notifications, restarts, wakes, peers, failures and unfinished calls", async () => {
    const records = [
      user("u1", 0),
      assistant("a1", 10, {
        durationMs: 50,
        stop: "error",
        failure: "503 upstream connect error",
      }),
      event("alert", 100, {
        eventType: "orb.alert",
        alert: { message: "Disk full", requestId: "q" },
      }),
      event("notify", 200, {
        custom: { customType: "subagent-notification", display: true },
        subagent: { kind: "notification", id: "2", description: "Audit charts", message: "m" },
      }),
      event("restart", 300, {
        custom: { customType: "pi-orb.harness-restarted", display: true },
        content: [{ type: "text", text: "Agent harness restarted." }],
      }),
      event("wake", 400, {
        custom: { customType: "pi-orb.sleep-wake", display: true },
        content: [{ type: "text", text: "Woke after sleep." }],
      }),
      event("peer", 500, {
        eventType: "orb.message",
        sender: { orbId: "other" },
        content: [{ type: "text", text: "Ping from another orb." }],
      }),
      event("model", 550, { eventType: "pi.model_change" }),
      assistant("a2", 600, {
        durationMs: 20,
        stop: "aborted",
        content: [call("c1", "bash", { command: "sleep 100" })],
      }),
    ];
    expect(await rows(records, "u1")).toEqual([
      expect.objectContaining({ id: "a1", stop: "error", error: "503 upstream connect error" }),
      { kind: "marker", id: "alert", start: T + 100, marker: "alert", text: "Disk full" },
      {
        kind: "marker",
        id: "notify",
        start: T + 200,
        marker: "notification",
        text: "Audit charts",
      },
      { kind: "marker", id: "restart", start: T + 300, marker: "restart" },
      { kind: "marker", id: "wake", start: T + 400, marker: "wake", text: "Woke after sleep." },
      {
        kind: "marker",
        id: "peer",
        start: T + 500,
        marker: "message",
        text: "Ping from another orb.",
      },
      expect.objectContaining({ id: "a2", stop: "aborted" }),
      {
        kind: "tool",
        id: "c1",
        start: T + 620,
        end: T + 620,
        name: "bash",
        arg: "sleep 100",
        nested: false,
        status: "unfinished",
      },
    ]);
  });

  it("bounds free text", async () => {
    const long = "x".repeat(900);
    const [model, tool] = await rows(
      [
        user("u1", 0),
        assistant("a1", 10, {
          durationMs: 1,
          stop: "toolUse",
          content: [{ type: "text", text: long }, call("c1", "bash", { command: long })],
        }),
        result("t1", 20, "c1", { durationMs: 1, text: long }),
      ],
      "u1",
    );
    expect(model?.kind === "model" && model.said?.length).toBe(500);
    expect(tool?.kind === "tool" && [tool.arg?.length, tool.result?.length]).toEqual([200, 200]);
    expect(tool?.kind === "tool" && tool.arg?.endsWith("…")).toBe(true);
  });
});

describe("Pi turn timeline errors", () => {
  const storeError: StoreError = {
    type: "store_error",
    code: "unavailable",
    message: "down",
    retryable: true,
  };

  it("distinguishes a missing, deleting or Claude orb", async () => {
    const records = [user("u1", 0)];
    expect(
      (await readTurnTimeline(task, deps(records, [], null).value, "orb", "u1"))._unsafeUnwrapErr(),
    ).toEqual({ type: "orb_missing" });
    const deleting = makeOrbRow("orb", "project", "deleting");
    expect(
      (
        await readTurnTimeline(task, deps(records, [], deleting).value, "orb", "u1")
      )._unsafeUnwrapErr(),
    ).toEqual({ type: "orb_missing" });
    const claude = { ...makeOrbRow("orb", "project", "running"), harness: "claude" as const };
    const notPi = deps(records, [], claude);
    expect((await readTurnTimeline(task, notPi.value, "orb", "u1"))._unsafeUnwrapErr()).toEqual({
      type: "not_pi",
    });
    expect(notPi.readTurnCalls).not.toHaveBeenCalled();
  });

  it("names the store that failed", async () => {
    const records = [user("u1", 0)];
    const failing = (source: "orb" | "history" | "model_calls"): TurnTimelineDeps => {
      const base = deps(records).value;
      return {
        store: {
          getOrb: source === "orb" ? () => errAsync(storeError) : base.store.getOrb,
          readHistorySnapshot:
            source === "history" ? () => errAsync(storeError) : base.store.readHistorySnapshot,
        },
        modelUsage:
          source === "model_calls"
            ? { readTurnCalls: () => errAsync(storeError) }
            : base.modelUsage,
      };
    };
    for (const source of ["orb", "history", "model_calls"] as const)
      expect(
        (await readTurnTimeline(task, failing(source), "orb", "u1"))._unsafeUnwrapErr(),
      ).toEqual({ type: "store_error", source, error: storeError });
  });
});

import { type HistoryRecord, TurnTimelineSchema, turnTimelinePath } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { errAsync, okAsync } from "neverthrow";
import { Check } from "typebox/value";
import { expect, it, vi } from "vitest";
import type { StoreError } from "../domain/errors.ts";
import type { TurnCallReader } from "../domain/turn-timeline.ts";
import {
  makeHarness,
  makeOrbRow,
  makeProjectRow,
  TEST_SYSTEM_VIEW,
  TEST_USER_ID,
} from "../testkit/fixtures.ts";
import { registerRoutes } from "./routes.ts";

const T = Date.UTC(2026, 9, 24, 12);

const records: HistoryRecord[] = [
  {
    id: "u1",
    parentId: null,
    timestamp: new Date(T).toISOString(),
    type: "message",
    role: "user",
    inboxMessageIds: ["m1"],
    content: [{ type: "text", text: "Go." }],
    overflow: {},
  },
  {
    id: "a1",
    parentId: "u1",
    timestamp: new Date(T + 100).toISOString(),
    type: "message",
    role: "assistant",
    model: { provider: "openai-codex", id: "gpt-6-astra" },
    finishReason: "stop",
    content: [{ type: "text", text: "Done." }],
    overflow: {
      native: { type: "message", message: { durationMs: 900, responseId: "r1" } },
    },
  },
];

async function serve(options: {
  harness?: "pi" | "claude";
  readTurnCalls?: TurnCallReader["readTurnCalls"];
}) {
  const task = new NoSimulationTask("turn timeline route", false);
  const log = vi.spyOn(task, "log");
  const harness = makeHarness();
  harness.store.seedProject(makeProjectRow("project"));
  harness.store.seedOrb({
    ...makeOrbRow("orb", "project", "stopped"),
    harness: options.harness ?? "pi",
  });
  (
    await harness.store.commitPullBatch(task, {
      orbId: "orb",
      expectedCursor: null,
      session: { id: "session", overflow: {} },
      records,
      nextCursor: "a1",
      nextHeadId: "a1",
    })
  )._unsafeUnwrap();
  const readTurnCalls = vi.fn(
    options.readTurnCalls ??
      (() =>
        okAsync([
          {
            at: T + 1000,
            use: "root",
            provider: "openai-codex",
            model: "gpt-6-astra",
            outcome: "stop",
            input: 1,
            output: 2,
            cacheRead: 3,
            cacheWrite: 0,
            responseId: "r1",
            ttftMs: 250,
          },
        ])),
  );
  const observe = vi.spyOn(harness.deps.hostProvider, "observe");
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (request) => {
    request.principal = { kind: "user", user: { id: TEST_USER_ID, email: null } };
  });
  registerRoutes(
    app,
    task,
    { ...harness.deps, modelUsage: { ...harness.deps.modelUsage, readTurnCalls } },
    {},
    TEST_SYSTEM_VIEW,
  );
  const edges = () =>
    log.mock.calls.map(([line]) => String(line)).filter((line) => line.includes("turn-timeline"));
  return { app, readTurnCalls, observe, edges };
}

it("returns one Pi turn's waterfall from the replica and the ledger without waking compute", async () => {
  const { app, readTurnCalls, observe, edges } = await serve({});
  try {
    const response = await app.inject({ method: "GET", url: turnTimelinePath("orb", "u1") });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    const body = response.json();
    expect(Check(TurnTimelineSchema, body)).toBe(true);
    expect(body).toEqual({
      start: T,
      rows: [
        {
          kind: "model",
          id: "a1",
          start: T + 100,
          end: T + 1000,
          use: "root",
          model: "gpt-6-astra",
          ttftMs: 250,
          stop: "stop",
          said: "Done.",
        },
      ],
    });
    expect(readTurnCalls.mock.calls[0]?.slice(1)).toEqual([
      "orb",
      { responseIds: ["r1"], from: T, until: T + 61_000 },
    ]);
    expect(observe).not.toHaveBeenCalled();
    expect(edges()).toEqual([]);
  } finally {
    await app.close();
  }
});

it("answers typed failures and logs one content-free edge for each", async () => {
  const { app, edges } = await serve({});
  try {
    for (const [url, status, code, message] of [
      [turnTimelinePath("missing", "u1"), 404, "not_found", "orb not found"],
      [turnTimelinePath("orb", "a1"), 404, "not_found", "turn not found"],
      [turnTimelinePath("orb", "nope"), 404, "not_found", "turn not found"],
    ] as const) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({ error: { code, message, retryable: false } });
    }
    expect(edges()).toEqual([
      "lifecycle: orb=missing turn-timeline-read-failed reason=orb_missing",
      "lifecycle: orb=orb turn-timeline-read-failed reason=turn_missing",
      "lifecycle: orb=orb turn-timeline-read-failed reason=turn_missing",
    ]);
  } finally {
    await app.close();
  }
});

it("refuses a Claude orb", async () => {
  const { app, readTurnCalls, edges } = await serve({ harness: "claude" });
  try {
    const response = await app.inject({ method: "GET", url: turnTimelinePath("orb", "u1") });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toEqual({
      code: "conflict",
      message: "orb is not a Pi orb",
      retryable: false,
    });
    expect(readTurnCalls).not.toHaveBeenCalled();
    expect(edges()).toEqual(["lifecycle: orb=orb turn-timeline-read-failed reason=not_pi"]);
  } finally {
    await app.close();
  }
});

it.each([
  ["unavailable", 503, "unavailable", true],
  ["invariant", 500, "internal", false],
] as const)("maps a %s ledger failure", async (storeCode, status, code, retryable) => {
  const error: StoreError = {
    type: "store_error",
    code: storeCode,
    message: "ledger failed",
    retryable,
  };
  const { app, edges } = await serve({ readTurnCalls: () => errAsync(error) });
  try {
    const response = await app.inject({ method: "GET", url: turnTimelinePath("orb", "u1") });
    expect(response.statusCode).toBe(status);
    expect(response.json().error).toEqual({
      code,
      message: "turn timeline unavailable",
      retryable,
    });
    expect(edges()).toEqual([
      `lifecycle: orb=orb turn-timeline-read-failed reason=store_error source=model_calls code=${storeCode}`,
    ]);
  } finally {
    await app.close();
  }
});

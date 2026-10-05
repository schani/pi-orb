import type { HistoryRecord } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow, TEST_USER_ID } from "../testkit/fixtures.ts";
import { enrichActivityHeadlines, generateActivityHeadline } from "./activity-headlines.ts";

export const headlineRef = {
  orbId: "orb",
  sessionId: "session",
  recordId: "record",
  detailKey: "record:0",
};
export const headlineRecord: HistoryRecord = {
  id: "record",
  parentId: null,
  overflow: {},
  timestamp: "2026-10-04T00:00:00Z",
  type: "message",
  role: "assistant",
  content: [
    {
      type: "tool_call",
      callId: "call",
      name: "codemode",
      arguments: { code: "PRIVATE_SOURCE_CANARY Inspect project configuration" },
    },
  ],
};
export async function seedHeadline(
  task: NoSimulationTask,
  harness: ReturnType<typeof makeHarness>,
) {
  harness.store.seedProject(makeProjectRow("project"));
  harness.store.seedOrb(makeOrbRow("orb", "project", "stopped"));
  return harness.store.commitPullBatch(task, {
    orbId: "orb",
    expectedCursor: null,
    session: { id: "session", overflow: {} },
    records: [headlineRecord],
    nextCursor: "record",
    nextHeadId: "record",
  });
}

class HeadlineLogTask extends NoSimulationTask {
  readonly lines: string[] = [];
  override log(...parts: readonly unknown[]): void {
    const line = parts.join(" ");
    if (line.startsWith("lifecycle:")) this.lines.push(line);
  }
}

function fields(line: string | undefined) {
  return Object.fromEntries(
    (line ?? "")
      .split(" ")
      .filter((token) => token.includes("="))
      .map((token) => token.split("=")),
  );
}

describe("activity headlines", () => {
  it("cache-read failure produces exactly one content-free terminal event", async () => {
    const task = new HeadlineLogTask("cache failure", false);
    const h = makeHarness();
    await seedHeadline(task, h);
    vi.spyOn(h.store, "readActivityHeadline").mockImplementationOnce(() =>
      errAsync({
        type: "store_error",
        code: "unavailable",
        message: "PRIVATE_PROVIDER_CANARY",
        retryable: true,
      }),
    );
    const result = await generateActivityHeadline(
      task,
      h.deps,
      headlineRef,
      undefined,
      "cache-failure",
    );
    expect(result._unsafeUnwrapErr()).toEqual({ type: "unavailable", stage: "source" });
    expect(task.lines).toHaveLength(1);
    expect(fields(task.lines[0])).toEqual({
      orb: "orb",
      session: "session",
      record: "record",
      detail: "record:0",
      correlation: "cache-failure",
      stage: "source",
      outcome: "unavailable",
      model: "gpt-6-luna",
      winner: "false",
      attempts: "0",
      termination: "not_retriable",
      elapsed_ms: expect.stringMatching(/^\d+(\.\d+)?$/),
    });
    expect(task.lines.join("\n")).not.toMatch(
      /PRIVATE_SOURCE_CANARY|PRIVATE_GENERATED_HEADLINE|PRIVATE_PROVIDER_CANARY/,
    );
  });
  it("an initial resource failure emits one terminal event rather than disappearing before cache lookup", async () => {
    const task = new HeadlineLogTask("missing orb", false);
    const h = makeHarness();
    expect(
      (
        await generateActivityHeadline(task, h.deps, headlineRef, undefined, "missing-orb")
      )._unsafeUnwrapErr().type,
    ).toBe("orb_missing");
    expect(task.lines).toHaveLength(1);
    expect(fields(task.lines[0])).toMatchObject({
      correlation: "missing-orb",
      stage: "source",
      outcome: "orb_missing",
    });
  });
  it("records one content-free terminal outcome, and no cache-hit noise", async () => {
    const task = new HeadlineLogTask("telemetry", false);
    const h = makeHarness();
    await seedHeadline(task, h);
    const deps = {
      ...h.deps,
      headlineGenerator: { generate: () => okAsync("PRIVATE_GENERATED_HEADLINE") },
    };
    expect(
      (await generateActivityHeadline(task, deps, headlineRef, undefined, "correlation-1")).isOk(),
    ).toBe(true);
    expect(
      (await generateActivityHeadline(task, deps, headlineRef, undefined, "cache-2")).isOk(),
    ).toBe(true);
    expect(task.lines).toHaveLength(1);
    expect(task.lines[0]).toContain("headline.completed");
    expect(fields(task.lines[0])).toEqual({
      orb: "orb",
      session: "session",
      record: "record",
      detail: "record:0",
      correlation: "correlation-1",
      stage: "persistence",
      outcome: "stored",
      model: "gpt-6-luna",
      winner: "true",
      attempts: "1",
      termination: "succeeded",
      generated_at: expect.stringMatching(/^\d+$/),
      elapsed_ms: expect.stringMatching(/^\d+(\.\d+)?$/),
    });
    expect(task.lines.join("\n")).not.toMatch(
      /PRIVATE_SOURCE_CANARY|PRIVATE_GENERATED_HEADLINE|PRIVATE_PROVIDER_CANARY/,
    );
    task.lines.length = 0;
    expect(
      (await generateActivityHeadline(task, deps, headlineRef, undefined, "cache-3")).isOk(),
    ).toBe(true);
    expect(task.lines).toHaveLength(0);
  });
  it("typed inference failures never cache output and allow manual retry", async () => {
    const task = new NoSimulationTask("inference failure", false);
    const h = makeHarness();
    await seedHeadline(task, h);
    const put = vi.spyOn(h.store, "putActivityHeadlineIfAbsent");
    const failed = await generateActivityHeadline(
      task,
      {
        ...h.deps,
        headlineGenerator: {
          generate: () => errAsync({ type: "headline_generation_failed", stage: "auth" }),
        },
      },
      headlineRef,
    );
    expect(failed._unsafeUnwrapErr()).toEqual({ type: "unavailable", stage: "inference" });
    expect(put).not.toHaveBeenCalled();
    expect((await generateActivityHeadline(task, h.deps, headlineRef)).isOk()).toBe(true);
  });
  it.each([
    { stage: "auth" as const, reason: "provider_error" as const, providerStatus: 503 },
    { stage: "inference" as const, reason: "completion_rejected" as const },
    { stage: "inference" as const, reason: "empty_text" as const },
    { stage: "inference" as const, reason: "provider_error" as const },
    { stage: "inference" as const, reason: "provider_error" as const, providerStatus: 429 },
    { stage: "inference" as const, reason: "provider_error" as const, providerStatus: 404 },
    { stage: "inference" as const, reason: "provider_error" as const, providerStatus: 502 },
  ])("does not retry other failures: %j", async (error) => {
    const task = new HeadlineLogTask("nonretryable", false);
    const h = makeHarness();
    await seedHeadline(task, h);
    const generate = vi.fn(() =>
      errAsync({ type: "headline_generation_failed" as const, ...error }),
    );
    const put = vi.spyOn(h.store, "putActivityHeadlineIfAbsent");
    const result = await generateActivityHeadline(
      task,
      { ...h.deps, headlineGenerator: { generate } },
      headlineRef,
    );
    expect(result.isErr()).toBe(true);
    expect(generate).toHaveBeenCalledOnce();
    expect(put).not.toHaveBeenCalled();
    expect(task.lines).toHaveLength(1);
    expect(fields(task.lines[0])).toMatchObject({
      attempts: "1",
      termination: "not_retriable",
      failure_stage: error.stage,
    });
  });
  it("existing ineligible read detail fails without inference or cache write", async () => {
    const task = new NoSimulationTask("text ineligible", false);
    const h = makeHarness();
    h.store.seedProject(makeProjectRow("project"));
    h.store.seedOrb(makeOrbRow("orb", "project", "archived"));
    await h.store.commitPullBatch(task, {
      orbId: "orb",
      expectedCursor: null,
      session: { id: "session", overflow: {} },
      records: [
        {
          ...headlineRecord,
          content: [
            { type: "tool_call", callId: "read", name: "read", arguments: { path: "config.ts" } },
          ],
        },
      ],
      nextCursor: "record",
      nextHeadId: "record",
    });
    const generate = vi.fn(() => okAsync("unused"));
    const result = await generateActivityHeadline(
      task,
      { ...h.deps, headlineGenerator: { generate } },
      headlineRef,
    );
    expect(result._unsafeUnwrapErr().type).toBe("ineligible");
    expect(generate).not.toHaveBeenCalled();
  });
  it("uses owner credentials and immutable replica without host IO; cached retry does not infer", async () => {
    const task = new NoSimulationTask("headline", false);
    const h = makeHarness();
    await seedHeadline(task, h);
    vi.spyOn(task, "monotonicNow").mockReturnValue(100);
    const generate = vi.fn((_task: unknown, _input: unknown, _context: unknown) =>
      okAsync("Inspect project configuration and identify relevant implementation boundaries"),
    );
    const host = vi.spyOn(h.deps.hostProvider, "observe");
    const deps = { ...h.deps, headlineGenerator: { generate } };
    const first = await generateActivityHeadline(task, deps, headlineRef);
    const second = await generateActivityHeadline(task, deps, headlineRef);
    expect(first.isOk()).toBe(true);
    expect(second).toEqual(first);
    expect(generate).toHaveBeenCalledOnce();
    expect(host).not.toHaveBeenCalled();
    expect(generate.mock.calls[0]?.[2]).toMatchObject({ deadlineAt: 30_100 });
    expect(generate.mock.calls[0]?.[1]).toMatchObject({
      ownerUserId: TEST_USER_ID,
      source: { kind: "intent", tool: "codemode" },
    });
  });
  it.each(["intent", "outcome"] as const)(
    "generates an inactive-branch %s from its own ancestry without host IO",
    async (kind) => {
      const task = new NoSimulationTask("inactive source", false);
      const h = makeHarness();
      h.store.seedProject(makeProjectRow("project"));
      h.store.seedOrb(makeOrbRow("orb", "project", "stopped"));
      const root: HistoryRecord = {
        ...headlineRecord,
        id: "root",
        role: "user",
        content: [{ type: "text", text: "OLD_USER_CANARY" }],
      };
      const call: HistoryRecord = {
        ...headlineRecord,
        parentId: root.id,
        content: [
          {
            type: "tool_call",
            callId: "reused",
            name: kind === "intent" ? "codemode" : "subagent",
            arguments: { code: "OLD_SOURCE_CANARY", prompt: "OLD_SOURCE_CANARY" },
          },
        ],
      };
      const result: HistoryRecord = {
        ...headlineRecord,
        id: "old-result",
        parentId: call.id,
        role: "tool",
        content: [
          {
            type: "tool_result",
            callId: "reused",
            content: [{ type: "text", text: "OLD_RESULT_CANARY" }],
          },
        ],
      };
      const sibling: HistoryRecord = {
        ...headlineRecord,
        id: "sibling",
        parentId: root.id,
        content: [
          {
            type: "tool_call",
            callId: "reused",
            name: "get_subagent_result",
            arguments: { private: "PRIVATE_SIBLING_CANARY" },
          },
        ],
      };
      const latest: HistoryRecord = {
        ...root,
        id: "latest",
        parentId: sibling.id,
        content: [{ type: "text", text: "PRIVATE_LATER_USER_CANARY" }],
      };
      const records = [root, call, result, sibling, latest];
      expect(
        (
          await h.store.commitPullBatch(task, {
            orbId: "orb",
            expectedCursor: null,
            session: { id: "session", overflow: {} },
            records,
            nextCursor: latest.id,
            nextHeadId: latest.id,
          })
        ).isOk(),
      ).toBe(true);
      const immutable = structuredClone(h.store.replicaRecords("orb"));
      const target = kind === "intent" ? call : result;
      const ref = { ...headlineRef, recordId: target.id, detailKey: `${target.id}:0` };
      const generate = vi.fn((_task: unknown, _input: unknown, _context: unknown) =>
        okAsync("Inspect the earlier branch"),
      );
      const host = vi.spyOn(h.deps.hostProvider, "observe");
      const snapshot = vi.spyOn(h.store, "readHistorySnapshot");
      const put = vi.spyOn(h.store, "putActivityHeadlineIfAbsent");
      const deps = { ...h.deps, headlineGenerator: { generate } };
      expect((await generateActivityHeadline(task, deps, ref)).isOk()).toBe(true);
      expect(snapshot).toHaveBeenCalledExactlyOnceWith(task, "orb", target.id);
      expect(generate).toHaveBeenCalledOnce();
      expect(generate.mock.calls[0]?.[1]).toMatchObject({
        ownerUserId: TEST_USER_ID,
        source: {
          kind,
          tool: kind === "intent" ? "codemode" : "subagent",
          text: JSON.stringify(
            kind === "intent"
              ? { code: "OLD_SOURCE_CANARY" }
              : { isError: false, text: "OLD_RESULT_CANARY" },
          ),
        },
      });
      expect(JSON.stringify(generate.mock.calls)).not.toMatch(
        /PRIVATE_SIBLING_CANARY|PRIVATE_LATER_USER_CANARY|OLD_USER_CANARY/,
      );
      expect(put.mock.calls[0]?.[1]).toMatchObject(ref);
      expect((await generateActivityHeadline(task, deps, ref)).isOk()).toBe(true);
      expect(generate).toHaveBeenCalledOnce();
      expect(host).not.toHaveBeenCalled();
      expect(h.store.replicaRecords("orb")).toEqual(immutable);
      expect((await h.store.getOrb(task, "orb"))._unsafeUnwrap()).toMatchObject({
        state: "stopped",
        harnessSessionId: "session",
        replicationCursor: latest.id,
        replicatedHeadId: latest.id,
      });
    },
  );
  it("rejects wrong session before cache or inference", async () => {
    const task = new NoSimulationTask("session", false);
    const h = makeHarness();
    await seedHeadline(task, h);
    const cache = vi.spyOn(h.store, "readActivityHeadline");
    const result = await generateActivityHeadline(task, h.deps, {
      ...headlineRef,
      sessionId: "other",
    });
    expect(result._unsafeUnwrapErr().type).toBe("invalid_session");
    expect(cache).not.toHaveBeenCalled();
  });
  it("rejects an existing ineligible detail without inference", async () => {
    const task = new NoSimulationTask("ineligible", false);
    const h = makeHarness();
    await seedHeadline(task, h);
    const generate = vi.fn(() => okAsync("should not infer"));
    const result = await generateActivityHeadline(
      task,
      { ...h.deps, headlineGenerator: { generate } },
      { ...headlineRef, detailKey: "record:99" },
    );
    expect(result._unsafeUnwrapErr().type).toBe("detail_missing");
    expect(generate).not.toHaveBeenCalled();
  });
  it("returns persistence unavailable, then permits a fresh manual retry", async () => {
    const task = new NoSimulationTask("persist", false);
    const h = makeHarness();
    await seedHeadline(task, h);
    const write = vi.spyOn(h.store, "putActivityHeadlineIfAbsent").mockImplementationOnce(() =>
      errAsync({
        type: "store_error",
        code: "unavailable",
        message: "private sql failure",
        retryable: true,
      }),
    );
    const failed = await generateActivityHeadline(task, h.deps, headlineRef);
    expect(failed._unsafeUnwrapErr()).toMatchObject({ type: "unavailable", stage: "persistence" });
    expect((await generateActivityHeadline(task, h.deps, headlineRef)).isOk()).toBe(true);
    expect(write).toHaveBeenCalledTimes(2);
  });
  it("bulk enrichment never infers and cache failure preserves browseable null markers", async () => {
    const task = new HeadlineLogTask("enrich", false);
    const h = makeHarness();
    await seedHeadline(task, h);
    await generateActivityHeadline(task, h.deps, headlineRef);
    const generate = vi.fn(() => okAsync("unused"));
    const bulk = vi.spyOn(h.store, "readActivityHeadlines");
    const result = await enrichActivityHeadlines(
      task,
      { ...h.deps, headlineGenerator: { generate } },
      "orb",
      "session",
      [headlineRecord],
    );
    expect(result._unsafeUnwrap()[0]).toMatchObject({
      content: [{ headline: expect.any(String) }],
    });
    expect(bulk).toHaveBeenCalledOnce();
    expect(generate).not.toHaveBeenCalled();
    task.lines.length = 0;
    bulk.mockImplementationOnce(() =>
      errAsync({ type: "store_error", code: "unavailable", message: "private", retryable: true }),
    );
    const fallback = await enrichActivityHeadlines(task, h.deps, "orb", "session", [
      headlineRecord,
    ]);
    expect(fallback._unsafeUnwrap()[0]).toMatchObject({ content: [{ headline: null }] });
    expect(task.lines).toHaveLength(0);
  });
});

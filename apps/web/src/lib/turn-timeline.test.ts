import type { TimelineRow } from "@pi-orb/protocol";
import { describe, expect, it } from "vitest";
import { barSegments, callCell, clock, duration, rowFacts, tipFacts } from "./turn-timeline.ts";

const T = Date.UTC(2026, 9, 24, 12);

type ModelRow = Extract<TimelineRow, { kind: "model" }>;

const model = (overrides: Partial<ModelRow> = {}, ...without: (keyof ModelRow)[]): ModelRow => {
  const row: Partial<ModelRow> = {
    kind: "model",
    id: "a1",
    start: T,
    end: T + 10_000,
    use: "root",
    model: "gpt-6-astra",
    ttftMs: 1_000,
    thinkingMs: 4_000,
    input: 1_000,
    output: 600,
    cacheRead: 9_000,
    cacheWrite: 0,
    costUsd: 0.0125,
    stop: "stop",
    said: "Done.\nAll green.",
    ...overrides,
  };
  for (const key of without) delete row[key];
  return row as ModelRow;
};

describe("timeline formatting", () => {
  it("formats durations at the precision that matters", () => {
    expect([0, 999.6, 1_234, 12_345, 65_000, 3_725_000].map(duration)).toEqual([
      "0ms",
      "1.0s",
      "1.2s",
      "12s",
      "1m 05s",
      "1h 02m",
    ]);
  });

  it("shows local wall-clock start times", () => {
    const at = new Date(2026, 9, 24, 9, 5, 7).getTime();
    expect(clock(at)).toBe("09:05:07");
  });
});

describe("timeline rows", () => {
  it("names a root call by model and what it said, and splits its timing", () => {
    const row = model();
    expect(callCell(row)).toEqual({ name: "gpt-6-astra", arg: "Done.", failed: false });
    expect(rowFacts(row)).toEqual([
      ["first token", "1.0s"],
      ["thinking", "3.0s"],
      ["streaming", "6.0s"],
      ["total", "10s"],
      ["input", "10.0k · 90% cache"],
      ["output", "600 · 67 tok/s"],
      ["cost", "$0.013"],
      ["stop", "stop"],
      ["said", "Done.\nAll green."],
    ]);
    expect(tipFacts(row).map(([label]) => label)).not.toContain("said");
    expect(barSegments(row)).toEqual([
      { phase: "wait", from: 0, to: 0.1 },
      { phase: "think", from: 0.1, to: 0.4 },
      { phase: "stream", from: 0.4, to: 1 },
    ]);
  });

  it("draws a call recorded before timing existed as one solid bar", () => {
    const row = model({}, "ttftMs", "thinkingMs", "said");
    expect(rowFacts(row).map(([label]) => label)).toEqual([
      "total",
      "input",
      "output",
      "cost",
      "stop",
    ]);
    expect(barSegments(row)).toEqual([{ phase: "stream", from: 0, to: 1 }]);
  });

  it("shows a failed call's error in its call cell and never as streaming", () => {
    const row = model({ stop: "error", error: "503 upstream" }, "thinkingMs");
    expect(callCell(row)).toEqual({ name: "gpt-6-astra", arg: "503 upstream", failed: true });
    expect(rowFacts(row)).toContainEqual(["failed after", "10s", true]);
    expect(rowFacts(row).map(([label]) => label)).not.toContain("error");
    expect(barSegments(row)).toEqual([{ phase: "wait", from: 0, to: 1 }]);
  });

  it("labels other model calls by their use", () => {
    expect(callCell(model({ use: "turn_summary" }, "said")).arg).toBe("turn summary");
  });

  it("describes tools by duration and result", () => {
    const tool: Extract<TimelineRow, { kind: "tool" }> = {
      kind: "tool",
      id: "c1",
      start: T,
      end: T + 2_500,
      name: "codemode",
      nested: false,
      status: "error",
      result: "Error: boom",
      calls: 3,
    };
    expect(callCell(tool)).toEqual({ name: "codemode", arg: "", failed: true });
    expect(rowFacts(tool)).toEqual([
      ["duration", "2.5s"],
      ["result", "Error: boom", true],
      ["calls", "3"],
    ]);
    const { result: _result, calls: _calls, ...unfinished } = tool;
    expect(rowFacts({ ...unfinished, status: "unfinished" })).toEqual([
      ["duration", "2.5s"],
      ["result", "unfinished", true],
    ]);
  });

  it("names markers without repeating their text", () => {
    const marker: TimelineRow = {
      kind: "marker",
      id: "m",
      start: T,
      marker: "steering",
      text: "Also the phone.",
    };
    expect(callCell(marker)).toEqual({ name: "steering", arg: "Also the phone.", failed: false });
    expect(rowFacts(marker)).toEqual([]);
    expect(callCell({ ...marker, marker: "alert", text: "Disk full" })).toEqual({
      name: "alert",
      arg: "Disk full",
      failed: true,
    });
  });
});

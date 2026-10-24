import type { TimelineRow } from "@pi-orb/protocol";

/** label, value, and whether the value reports a failure. */
export type Fact = readonly [string, string] | readonly [string, string, true];
export type Phase = "wait" | "think" | "stream";
export interface Segment {
  readonly phase: Phase;
  /** Fractions of the bar. */
  readonly from: number;
  readonly to: number;
}

const two = (value: number) => String(value).padStart(2, "0");

export function clock(ms: number): string {
  const at = new Date(ms);
  return `${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`;
}

export function duration(ms: number): string {
  const rounded = Math.max(0, Math.round(ms));
  if (rounded < 1000) return `${rounded}ms`;
  const seconds = rounded / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${two(Math.floor(seconds % 60))}s`;
  return `${Math.floor(minutes / 60)}h ${two(minutes % 60)}m`;
}

function tokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 100_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}

function cost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.001) return "<$0.001";
  return usd < 0.1 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;
}

const MARKER_NAMES: Record<Extract<TimelineRow, { kind: "marker" }>["marker"], string> = {
  steering: "steering",
  message: "message",
  notification: "notification",
  alert: "alert",
  restart: "harness restarted",
  wake: "woke",
  compaction: "context compacted",
};

export function failed(row: TimelineRow): boolean {
  if (row.kind === "model") return row.stop === "error" || row.stop === "aborted";
  if (row.kind === "tool") return row.status !== "ok";
  return row.marker === "alert";
}

/** Luna side calls draw grey; compaction hatched; root and subagent calls in phases. */
export function modelStyle(
  row: Extract<TimelineRow, { kind: "model" }>,
): "llm" | "compaction" | "aux" {
  if (row.use === "compaction") return "compaction";
  return row.use === "root" || row.use === "subagent" ? "llm" : "aux";
}

/** The call cell: what ran and its subject. */
export function callCell(row: TimelineRow): { name: string; arg: string; failed: boolean } {
  const bad = failed(row);
  if (row.kind === "marker")
    return { name: MARKER_NAMES[row.marker], arg: row.text ?? "", failed: bad };
  if (row.kind === "tool") return { name: row.name, arg: row.arg ?? "", failed: bad };
  const arg =
    row.error ??
    (row.use === "root" ? (row.said?.split("\n")[0] ?? "") : row.use.replaceAll("_", " "));
  return { name: row.model, arg, failed: bad };
}

function modelFacts(row: Extract<TimelineRow, { kind: "model" }>): Fact[] {
  const facts: Fact[] = [];
  const total = row.end - row.start;
  const bad = failed(row);
  if (row.ttftMs !== undefined) facts.push(["first token", duration(row.ttftMs)]);
  if (row.ttftMs !== undefined && row.thinkingMs !== undefined)
    facts.push(["thinking", duration(row.thinkingMs - row.ttftMs)]);
  if (row.ttftMs !== undefined && !bad)
    facts.push(["streaming", duration(total - (row.thinkingMs ?? row.ttftMs))]);
  facts.push(bad ? ["failed after", duration(total), true] : ["total", duration(total)]);
  if (row.input !== undefined) {
    const prompt = row.input + (row.cacheRead ?? 0) + (row.cacheWrite ?? 0);
    const cached = row.cacheRead ? ` · ${Math.round((row.cacheRead / prompt) * 100)}% cache` : "";
    facts.push(["input", tokens(prompt) + cached]);
  }
  if (row.output !== undefined) {
    const streaming = (total - (row.ttftMs ?? 0)) / 1000;
    const rate = streaming > 0 ? ` · ${Math.round(row.output / streaming)} tok/s` : "";
    facts.push(["output", tokens(row.output) + rate]);
  }
  if (row.costUsd !== undefined) facts.push(["cost", cost(row.costUsd)]);
  if (row.stop !== undefined) facts.push(["stop", row.stop]);
  if (row.error !== undefined) facts.push(["error", row.error, true]);
  if (row.said !== undefined) facts.push(["said", row.said]);
  return facts;
}

/** Facts for the expanded row, without what the call cell already shows. */
export function rowFacts(row: TimelineRow): Fact[] {
  const facts: Fact[] =
    row.kind === "model"
      ? modelFacts(row)
      : row.kind === "tool"
        ? [
            ["duration", duration(row.end - row.start)],
            ...(row.result !== undefined || row.status !== "ok"
              ? [
                  row.status === "ok"
                    ? (["result", row.result ?? ""] as const)
                    : (["result", row.result ?? row.status, true] as const),
                ]
              : []),
            ...(row.calls === undefined ? [] : [["calls", String(row.calls)] as const]),
          ]
        : [];
  const { name, arg } = callCell(row);
  return facts.filter(([, value]) => value !== name && value !== arg);
}

/** The hover tooltip leaves long text to the expanded row. */
export function tipFacts(row: TimelineRow): Fact[] {
  return rowFacts(row).filter(([label]) => label !== "said");
}

/** A model bar's phases: outlined waiting, checkered thinking, solid streaming; failures never stream. */
export function barSegments(row: Extract<TimelineRow, { kind: "model" }>): Segment[] {
  const total = row.end - row.start;
  const at = (ms: number) => (total > 0 ? Math.min(1, Math.max(0, ms / total)) : 0);
  const bad = failed(row);
  const raw: Segment[] =
    row.ttftMs === undefined
      ? [{ phase: "stream", from: 0, to: 1 }]
      : [
          { phase: "wait", from: 0, to: at(row.ttftMs) },
          ...(row.thinkingMs === undefined
            ? []
            : [{ phase: "think" as const, from: at(row.ttftMs), to: at(row.thinkingMs) }]),
          { phase: "stream", from: at(row.thinkingMs ?? row.ttftMs), to: 1 },
        ];
  const segments: Segment[] = [];
  for (const segment of raw) {
    const phase = bad && segment.phase === "stream" ? "wait" : segment.phase;
    if (segment.to <= segment.from) continue;
    const last = segments.at(-1);
    if (last?.phase === phase) segments[segments.length - 1] = { ...last, to: segment.to };
    else segments.push({ phase, from: segment.from, to: segment.to });
  }
  return segments;
}

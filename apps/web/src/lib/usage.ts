import type { BarChart, LineChart, ModelCallUse, UsageTotals, UsageView } from "@pi-orb/protocol";
import type { ChartXAxis } from "./chart-spec.ts";

export type UsagePeriod = "day" | "week" | "month" | "six_months";
export type UsageBreakdown = "token_kind" | "use" | "model";
export type UsageMeasure = "total" | "input" | "output" | "cacheRead" | "cacheWrite";
export const USE_LABELS: Record<ModelCallUse, string> = {
  root: "Root",
  subagent: "Subagent",
  compaction: "Compaction",
  turn_summary: "Turn summary",
  headline: "Headline",
  orb_name: "Orb name",
};
export const TOKEN_LABELS = {
  input: "Uncached input",
  cacheRead: "Cached input",
  cacheWrite: "Cache write",
  output: "Output",
} as const;

export const formatUsageCount = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 2,
}).format;

export const totalTokens = (row: UsageTotals) =>
  row.input + row.output + row.cacheRead + row.cacheWrite;
export function cacheShare(row: UsageTotals): number | null {
  const prompt = row.input + row.cacheRead + row.cacheWrite;
  return prompt === 0 ? null : row.cacheRead / prompt;
}

/** Rolling hours for day/week, clamped calendar months, one civil-time edge per long-range day. */
export function usageBoundaries(period: UsagePeriod, now: number): number[] {
  const end = new Date(now);
  const start = new Date(now);
  if (period === "day" || period === "week")
    start.setTime(now - (period === "day" ? 24 : 168) * 3_600_000);
  else {
    start.setDate(1);
    start.setMonth(start.getMonth() - (period === "month" ? 1 : 6));
    start.setDate(
      Math.min(end.getDate(), new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate()),
    );
  }
  const result: number[] = [];
  if (period === "six_months") {
    for (let day = 0; ; day++) {
      const date = new Date(start);
      date.setDate(start.getDate() + day);
      if (date.getTime() >= now) break;
      result.push(date.getTime());
    }
  } else {
    const step = (period === "day" ? 0.25 : period === "week" ? 1 : 6) * 3_600_000;
    for (let at = start.getTime(); at < now; at += step) result.push(at);
  }
  result.push(now);
  return result;
}

/** A tick per bucket; labels on local 3-hour, midnight or month-start boundaries. */
export function usageAxis(period: UsagePeriod, boundaries: readonly number[]): ChartXAxis {
  const first = boundaries[0] ?? 0;
  const mark = new Date(first);
  mark.setMinutes(0, 0, 0);
  mark.setHours(period === "day" ? mark.getHours() - (mark.getHours() % 3) : 0);
  if (period === "six_months") mark.setDate(1);
  const labels: number[] = [];
  for (; mark.getTime() < (boundaries.at(-1) ?? 0); ) {
    if (mark.getTime() >= first) labels.push(mark.getTime());
    if (period === "day") mark.setHours(mark.getHours() + 3);
    else if (period === "six_months") mark.setMonth(mark.getMonth() + 1);
    else mark.setDate(mark.getDate() + 1);
  }
  return {
    ticks: boundaries.slice(0, -1),
    labels,
    format: period === "day" ? "%H:%M" : period === "six_months" ? "%b" : "%b %d",
  };
}

export function usageTimeline(data: UsageView, breakdown: UsageBreakdown): LineChart {
  const times = data.boundaries.slice(0, -1);
  const groups = new Map<string, Map<number, number>>();
  const add = (name: string, at: number, value: number) => {
    const points = groups.get(name) ?? new Map<number, number>();
    points.set(at, (points.get(at) ?? 0) + value);
    groups.set(name, points);
  };
  if (breakdown === "token_kind")
    for (const name of Object.values(TOKEN_LABELS)) groups.set(name, new Map());
  if (breakdown === "use")
    for (const name of Object.values(USE_LABELS)) groups.set(name, new Map());
  for (const row of data.buckets) {
    if (breakdown === "token_kind") {
      for (const key of Object.keys(TOKEN_LABELS) as (keyof typeof TOKEN_LABELS)[])
        add(TOKEN_LABELS[key], row.at, row[key]);
    } else
      add(
        breakdown === "use" ? USE_LABELS[row.use] : row.provider + " / " + row.model,
        row.at,
        totalTokens(row),
      );
  }
  let entries = [...groups.entries()];
  if (breakdown === "model") {
    const sum = (points: Map<number, number>) => [...points.values()].reduce((a, b) => a + b, 0);
    entries.sort((a, b) => sum(b[1]) - sum(a[1]) || a[0].localeCompare(b[0]));
    if (entries.length > 6) {
      const other = new Map<number, number>();
      for (const [, points] of entries.slice(5))
        for (const [at, value] of points) other.set(at, (other.get(at) ?? 0) + value);
      entries = [...entries.slice(0, 5), ["Other", other]];
    }
  }
  if (entries.length === 0) entries = [["All tokens", new Map()]];
  return {
    kind: "line",
    title: "Consumption over time",
    unit: "tokens",
    series: entries.map(([name, points]) => ({
      name,
      points: times.map((at) => [at, points.get(at) ?? 0]),
    })),
  };
}

export interface RankedUsageOrb {
  id: string;
  label: string;
  value: number;
}

export function usageRankings(
  data: UsageView,
  measure: UsageMeasure,
): { orbs: RankedUsageOrb[]; uses: BarChart | null } {
  const value = (row: UsageTotals) => (measure === "total" ? totalTokens(row) : row[measure]);
  const orbs = [...data.orbs]
    .sort((a, b) => value(b) - value(a) || a.id.localeCompare(b.id))
    .slice(0, 5);
  const labels = orbs.map((row) => row.name ?? row.id);
  const useTotals = new Map<ModelCallUse, number>();
  for (const row of data.buckets)
    useTotals.set(row.use, (useTotals.get(row.use) ?? 0) + value(row));
  const useBars = [...useTotals.entries()]
    .map(([use, n]) => ({ label: USE_LABELS[use], value: n }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  return {
    orbs: orbs.map((row, index) => ({
      id: row.id,
      label:
        labels.filter((label) => label === labels[index]).length > 1
          ? (row.name ?? row.id) + " · " + row.id
          : (row.name ?? row.id),
      value: value(row),
    })),
    uses:
      useBars.length === 0 ? null : { kind: "bar", title: "Use", unit: "tokens", bars: useBars },
  };
}

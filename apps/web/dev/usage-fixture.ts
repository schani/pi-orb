import type { ModelCallUse, UsageTotals, UsageView } from "@pi-orb/protocol";

const uses: readonly ModelCallUse[] = [
  "root",
  "subagent",
  "compaction",
  "turn_summary",
  "headline",
  "orb_name",
];
const models = ["gpt-6.1", "gpt-6.1-mini", "gpt-5.4", "gpt-5.4-mini"];
const names = [
  "Provider cache audit",
  "Token usage dashboard",
  "Durable recovery",
  "Agent SDK parity",
  null,
];
const usageOrbId = (index: number) =>
  "10000000-0000-4000-8000-" + String(index + 1).padStart(12, "0");
export const usageOrbs = names.map((name, index) => ({
  id: usageOrbId(index),
  name,
}));
const keys = ["input", "output", "cacheRead", "cacheWrite", "calls"] as const;
const empty = (): UsageTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 });
const add = (target: UsageTotals, row: UsageTotals) => {
  for (const key of keys) target[key] += row[key];
};

/** Fixed quarter-hour events make overlapping mock reads additive and reproducible. */
export function usageFixture(boundaries: readonly number[]): UsageView {
  const summary = empty();
  const buckets = new Map<string, UsageView["buckets"][number]>();
  const orbs = new Map<number, UsageView["orbs"][number]>();
  const step = 900000;
  const start = Math.max(boundaries[0] ?? 0, Date.UTC(2026, 3, 1));
  const end = boundaries.at(-1) ?? 0;
  let bucket = 0;
  for (let at = Math.ceil(start / step) * step; at < end; at += step) {
    while (at >= (boundaries[bucket + 1] ?? end)) bucket++;
    const tick = at / step;
    for (const [index, use] of uses.entries()) {
      const modelIndex = (tick + index) % models.length;
      const factor =
        (6 - index) *
        (0.8 + 0.2 * Math.sin(tick / 9) + 0.3 * Math.cos(tick / 97)) *
        (1 + modelIndex * 0.12);
      const row: UsageTotals = {
        input: Math.round(450 * factor),
        output: Math.round(800 * factor * (1 + 0.25 * Math.sin(tick / 3 + index))),
        cacheRead: Math.round(2600 * factor * (0.8 + 0.2 * Math.cos(tick / 37))),
        cacheWrite: Math.round(120 * factor),
        calls: 1,
      };
      const model = models[modelIndex] ?? "gpt-5.4-mini";
      const provider = index < 3 ? "openai-codex" : "openai";
      const orb = (tick + index) % names.length;
      const orbId = usageOrbId(orb);
      const key = bucket + "/" + use + "/" + model + "/" + orbId;
      let group = buckets.get(key);
      if (group === undefined) {
        group = { ...empty(), at: boundaries[bucket] ?? start, orbId, use, provider, model };
        buckets.set(key, group);
      }
      add(group, row);
      let total = orbs.get(orb);
      if (total === undefined) {
        total = {
          ...empty(),
          id: usageOrbId(orb),
          name: names[orb] ?? null,
        };
        orbs.set(orb, total);
      }
      add(total, row);
      add(summary, row);
    }
  }
  return {
    boundaries: [...boundaries],
    summary,
    buckets: [...buckets.values()],
    orbs: [...orbs.values()],
  };
}

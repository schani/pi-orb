import { CHART_CONTENT_TYPE, type ChartSpec, type HistoryRecord } from "@pi-orb/protocol";

function rng(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic Datadog-shaped series for the transcript chart fixture orb. */
const T0 = Date.UTC(2026, 9, 13, 18, 0);
const STEP = 5 * 60_000;
const DEPLOY = T0 + 3 * 3_600_000 + STEP;
const times = Array.from({ length: 73 }, (_, index) => T0 + index * STEP);
function points(seed: number, value: (t: number, random: () => number) => number) {
  const random = rng(seed);
  return times.map((t): [number, number] => [t, value(t, random)]);
}

export const CHART_FIXTURE_LATENCY: ChartSpec = {
  kind: "line",
  title: "checkout-api p95 latency",
  unit: "ms",
  source: "https://app.datadoghq.com/metric/explorer",
  series: [
    {
      name: "p95",
      points: points(7, (t, r) =>
        Math.round(t >= DEPLOY ? 400 + (r() - 0.5) * 40 : 180 + (r() - 0.5) * 28),
      ),
    },
  ],
  markers: [{ at: DEPLOY, label: "deploy a41c9e2" }],
  thresholds: [{ value: 300, label: "SLO 300 ms" }],
};

export const CHART_FIXTURE_REGIONS: ChartSpec = {
  kind: "line",
  title: "checkout-api p95 by region",
  unit: "ms",
  series: [
    ["us-east", 11, 212, 330],
    ["eu-central", 13, 218, 410],
    ["us-west", 17, 206, 260],
  ].map(([name, seed, after, before]) => ({
    name: String(name),
    points: points(Number(seed), (t, r) =>
      Math.round(
        t >= DEPLOY ? Number(after) + (r() - 0.5) * 10 : Number(before) + (r() - 0.5) * 30,
      ),
    ),
  })),
  markers: [{ at: DEPLOY, label: "rollback" }],
};

export const CHART_FIXTURE_ZONES: ChartSpec = {
  kind: "line",
  title: "checkout-api p95 by zone",
  unit: "ms",
  series: [
    ["us-east-1a", 21, 190, 190],
    ["us-east-1b", 22, 520, 200],
    ["us-east-1c", 23, 206, 206],
    ["us-west-2a", 24, 241, 241],
    ["us-west-2b", 25, 234, 234],
    ["us-west-2c", 26, 181, 181],
  ].map(([name, seed, after, before]) => ({
    name: String(name),
    points: points(Number(seed), (t, r) =>
      Math.round((t >= DEPLOY ? Number(after) : Number(before)) + (r() - 0.5) * 22),
    ),
  })),
  markers: [{ at: DEPLOY, label: "deploy a41c9e2" }],
};

export const CHART_FIXTURE_ENDPOINTS: ChartSpec = {
  kind: "bar",
  title: "slowest endpoints · p95, last 15 min",
  unit: "ms",
  bars: [
    { label: "POST /checkout", value: 412 },
    { label: "POST /payments/authorize", value: 288 },
    { label: "GET /cart", value: 141 },
    { label: "GET /products/:id", value: 96 },
    { label: "GET /health", value: 4 },
  ],
};

function gauss(random: () => number) {
  return Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
}

export const CHART_FIXTURE_BAND: ChartSpec = {
  kind: "line",
  title: "checkout-api latency · p50, p5–p95",
  unit: "ms",
  series: [
    {
      name: "p50",
      points: points(31, (t, r) => Math.round((t >= DEPLOY ? 188 : 172) + gauss(r) * 5)),
      band: {
        name: "p5–p95",
        points: times.map((t, index): [number, number, number] => {
          const r = rng(1_000 + index);
          const after = t >= DEPLOY;
          return [
            t,
            Math.round((after ? 92 : 96) + gauss(r) * 3),
            Math.round((after ? 430 : 236) + gauss(r) * (after ? 14 : 7)),
          ];
        }),
      },
    },
  ],
  markers: [{ at: DEPLOY, label: "deploy a41c9e2" }],
};

const latency = (seed: number, slow: number) => {
  const random = rng(seed);
  return Array.from({ length: 1_500 }, () =>
    Math.round(
      random() < slow
        ? Math.max(200, 425 + gauss(random) * 42)
        : Math.max(30, 168 + gauss(random) * 38),
    ),
  );
};

export const CHART_FIXTURE_DISTRIBUTION: ChartSpec = {
  kind: "histogram",
  title: "checkout-api latency distribution · before vs after a41c9e2",
  unit: "ms",
  series: [
    { name: "before", values: latency(41, 0) },
    { name: "after", values: latency(42, 0.18) },
  ],
};

const RUN = Date.UTC(2026, 9, 13, 21, 0);
export const CHART_FIXTURE_RUN: ChartSpec = {
  kind: "timeline",
  title: "Deploy run 38800758118",
  spans: (
    [
      ["setup", "queued", 0, 38, "queued"],
      ["setup", "npm ci", 38, 104, "critical"],
      ["check", "typecheck", 104, 162],
      ["check", "lint", 162, 190],
      ["unit", "vitest · 2,431 tests", 104, 298],
      ["dst", "determined · 400 seeds", 104, 262],
      ["image", "queued", 104, 141, "queued"],
      ["image", "build runtime image", 141, 612, "critical"],
      ["e2e", "chromium", 298, 503],
      ["e2e", "webkit", 503, 548, "failed"],
      ["e2e", "webkit · retry", 548, 604],
      ["deploy", "push", 612, 671, "critical"],
      ["deploy", "cloud run rollout", 671, 872, "critical"],
    ] as const
  ).map(([lane, label, start, end, state]) => ({
    lane,
    label,
    start: RUN + start * 1_000,
    end: RUN + end * 1_000,
    ...(state === "critical" ? { critical: true } : state === undefined ? {} : { state }),
  })),
};

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const CHART_FIXTURE_FAILURES: ChartSpec = {
  kind: "heatmap",
  title: "CI failures by weekday and hour · last 8 weeks",
  unit: "failures",
  x: Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, "0")),
  y: DAYS,
  values: DAYS.map((_, day) => {
    const random = rng(60 + day);
    return Array.from({ length: 24 }, (_, hour) => {
      const work = day < 5 && hour >= 8 && hour <= 19 ? 1.4 : 0.15;
      return (
        Math.floor(random() * 2.2 * work) +
        (hour === 2 ? 5 + Math.floor(random() * 4) : 0) +
        (day === 0 && hour === 9 ? 11 : 0)
      );
    });
  }),
};

export const CHART_FIXTURE_SERVICE_TIME: ChartSpec = {
  kind: "compare",
  title: "Alpine · p95 per-job service time",
  unit: "s",
  from: "TS 5.9",
  to: "tsrs 0.18",
  better: "lower",
  rows: [
    { label: "1 concurrent", from: 3.97, to: 0.42 },
    { label: "2 concurrent", from: 6.97, to: 0.73 },
    { label: "4 concurrent", from: 13, to: 1.6 },
    { label: "8 concurrent", from: 27.7, to: 3.22 },
  ],
};

export const CHART_FIXTURE_BENCHMARKS: ChartSpec = {
  kind: "compare",
  title: "benchmarks · main → feat/stream-diff",
  unit: "ms",
  from: "main",
  to: "feat/stream-diff",
  better: "lower",
  rows: (
    [
      ["render 10k-line diff", 184, 61],
      ["parse unified diff", 22.4, 9.8],
      ["highlight · ts", 48.1, 41.2],
      ["tokenize markdown", 12.1, 11.9],
      ["hydrate orb list", 31.2, 33],
      ["serialize history", 18.3, 21.7],
      ["cold start", 420, 512],
    ] as const
  ).map(([label, from, to]) => ({ label, from, to })),
};

export function chartFixtureRecords(createdAt: string): HistoryRecord[] {
  const charts = [
    CHART_FIXTURE_LATENCY,
    CHART_FIXTURE_REGIONS,
    CHART_FIXTURE_ZONES,
    CHART_FIXTURE_ENDPOINTS,
    CHART_FIXTURE_BAND,
    CHART_FIXTURE_DISTRIBUTION,
    CHART_FIXTURE_RUN,
    CHART_FIXTURE_FAILURES,
    CHART_FIXTURE_SERVICE_TIME,
    CHART_FIXTURE_BENCHMARKS,
  ];
  return [
    {
      id: "charts-ask",
      parentId: null,
      timestamp: createdAt,
      type: "message",
      role: "user",
      inboxMessageIds: ["inbox-charts-ask"],
      content: [{ type: "text", text: "Why did checkout get slow this afternoon? Check Datadog." }],
      overflow: {},
    },
    {
      id: "charts-call",
      parentId: "charts-ask",
      timestamp: createdAt,
      type: "message",
      role: "assistant",
      content: [
        {
          type: "tool_call",
          callId: "charts-codemode",
          name: "codemode",
          arguments: {
            code: 'const p95 = await tools.datadog_get_datadog_metric({ query: "p95:trace.http.request.duration{service:checkout-api}" });',
          },
        },
      ],
      overflow: {},
    },
    {
      id: "charts-result",
      parentId: "charts-call",
      timestamp: createdAt,
      type: "message",
      role: "tool",
      content: [
        {
          type: "tool_result",
          callId: "charts-codemode",
          content: [
            { type: "text", text: "Script completed" },
            ...charts.map((data) => ({
              type: "other" as const,
              contentType: CHART_CONTENT_TYPE,
              data,
            })),
          ],
        },
      ],
      overflow: {},
    },
    {
      id: "charts-answer",
      parentId: "charts-result",
      timestamp: createdAt,
      type: "message",
      role: "assistant",
      content: [
        {
          type: "text",
          text: "`checkout-api` p95 jumped from ~180 ms to ~400 ms at 21:05, the minute deploy `a41c9e2` finished. Only `us-east-1b` is affected.",
        },
      ],
      overflow: {},
    },
  ];
}

import { CHART_CONTENT_TYPE, type ChartSpec, type HistoryRecord } from "@pi-orb/protocol";

/** Deterministic Datadog-shaped series for the transcript chart fixture orb. */
function rng(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

export function chartFixtureRecords(createdAt: string): HistoryRecord[] {
  const charts = [
    CHART_FIXTURE_LATENCY,
    CHART_FIXTURE_REGIONS,
    CHART_FIXTURE_ZONES,
    CHART_FIXTURE_ENDPOINTS,
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

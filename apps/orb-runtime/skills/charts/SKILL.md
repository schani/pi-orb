---
name: charts
description: 'Show the user charts (metrics, Datadog series, percentile bands, distributions, CI runs and traces, weekday × hour patterns, baseline vs candidate benchmarks, counts) as transcript rows with code-mode chart(): line, bar, histogram, timeline, heatmap and compare spec formats, what is drawn automatically, limits, and what is not supported.'
---

# Charts

In code mode, `await chart(spec)` shows the user a chart as its own row in the transcript, under the call that produced it. The row is open by default and folds to a sparkline. Use it when a shape answers the question faster than prose: a metric over time, a before/after, several services side by side, a ranking, a distribution, where a run's time went, when something happens, how a candidate compares with a baseline case by case.

The chart's data never reaches you. Fetch, reshape and chart inside one script, and `text()` the few numbers your answer needs: you cannot see the chart.

```js
// Discover the tool name (it depends on the configured server) and reply shape first, e.g. with
// text(await searchTools("datadog metric")) in an earlier script.
const reply = await tools.mcp__datadog__get_datadog_metric({ query: "p95:trace.http.request.duration{service:checkout-api}", from: "now-6h" });
if (reply.isError) throw new Error("metric query failed");
const points = reply.structuredContent.series[0].pointlist;  // adapt to the real reply: [[epochMs, value], ...]
await chart({
  kind: "line",
  title: "checkout-api p95 latency",
  unit: "ms",
  source: "https://app.datadoghq.com/metric/explorer?query=…",
  series: [{ name: "p95", points }],
  markers: [{ at: "2026-10-13T14:05:00Z", label: "deploy a41c9e2" }],
  thresholds: [{ value: 300, label: "SLO 300 ms" }],
});
const values = points.map(([, v]) => v).filter((v) => v !== null);
text({ before: values[0], latest: values.at(-1), max: Math.max(...values) });
```

## Spec

Line chart — values over time:

- `kind: "line"`, `title` (≤120 characters).
- `series: [{ name, points: [[time, value], …] }]` — 1 to 6 series, unique names (≤80 characters each). `time` is an ISO 8601 string or epoch milliseconds; `value` a finite number or `null` (dropped; a series must keep at least one point).
- `markers?: [{ at: time, label }]` — up to 8 vertical dashed rules, e.g. deploys or incidents.
- `thresholds?: [{ value, label }]` — up to 4 horizontal red rules, e.g. SLOs. Red means a limit; do not use thresholds for decoration.
- A series may carry `band: { name, points: [[time, low, high], …] }`, a shaded range behind its line, e.g. `{ name: "p5–p95" }` around a p50 line, or min–max over benchmark runs. `null` low or high drops the point. Band names must differ from series names; band points count toward the point limit.

Bar chart — one value per category, drawn in the given order (sort first):

- `kind: "bar"`, `title`, `bars: [{ label, value }]` — 1 to 40 bars.

Histogram — distribution of raw values, e.g. request latencies or test durations:

- `kind: "histogram"`, `title`, `series: [{ name, values: [number, …] }]` — 1 or 2 series (e.g. before and after); pass raw values, not bins.

Timeline — spans on lanes, e.g. CI jobs, trace spans, boot phases:

- `kind: "timeline"`, `title`, `spans: [{ lane, label, start, end, state?, critical? }]` — 1 to 200 spans. `start`/`end` are times like line points; the axis shows elapsed time from the first start. `state: "failed"` draws red, `"queued"` outlined; `critical: true` marks the critical path in black. Lanes appear in first-use order.

Heatmap — one value per pair of categories, e.g. failures by weekday × hour, latency bucket × time:

- `kind: "heatmap"`, `title`, `x: [label, …]` (≤60), `y: [label, …]` (≤40), `values` — one row per `y` label, each with one non-negative number per `x` label.

Compare — a baseline against a candidate, one row per case, e.g. `main` vs a branch per benchmark, or TS vs a port per concurrency level. Use this instead of paired bars:

- `kind: "compare"`, `title`, `from` and `to` (names of baseline and candidate), `better: "lower" | "higher"`, `tolerance?` (percent of the baseline counted as unchanged, default 5), `rows: [{ label, from, to }]` — 1 to 40 rows with positive values, unique labels, drawn in the given order.

Both:

- `unit?` (≤12 characters, not on timelines): `"ms"`, `"%"`, `"req/s"`… Shown on the axis, labels and tooltip.
- `source?`: an http(s) link to where the data came from, such as the Datadog query; the row links it by hostname.

## Drawn automatically

Styling is fixed; the spec has no colour, size or style options.

- Up to 3 lines in black, grey dashed and grey dotted; 4 to 6 lines in distinct colours, assigned in series order.
- Each line is named at its end with its latest value; crowded names are spread out with leader lines. A single line's latest value appears in the folded row instead.
- Hover shows every series at that time, highest first. Hovering a series name isolates its line.
- The y axis starts at zero (or below, for negative values) with headroom; the time axis is formatted in the viewer's local time.
- Histograms bin all series on one grid; the last series is filled black, an earlier one a grey outline, each with p50/p95/p99 ticks. Hovering a series name isolates it.
- Timeline spans show their label and duration when they fit; the folded row shows the run's total duration.
- Heatmap cells are shaded by value; exact values are on hover.
- Compare draws a hollow baseline dot and a filled candidate dot per row with the change as a multiple ("9.5× better"); rows worse than `tolerance` are red, rows within it grey and "same". Values spanning a decade or more use a log scale. The folded row counts worse rows.

## Limits

Enforced by `chart()`; a violation rejects inside the script with the reason, so fix the spec and retry.

- 6 series per line chart: fold the rest into one "other" series or split into several charts.
- 5,000 points per chart, including band points and histogram values: downsample or sample first (e.g. a 6-hour window at one-minute resolution is 360 points per series).
- 40 bars per bar chart.
- 8 charts per script.
- Unknown fields are rejected; there is no way to load remote data.

## Not supported

Scatter, stacked area, pie, dual y axes, logarithmic scales, annotations beyond markers and thresholds, custom colours or styling, and live or refreshing charts. A chart is a frozen record of this turn. Other harnesses without code mode cannot show charts.

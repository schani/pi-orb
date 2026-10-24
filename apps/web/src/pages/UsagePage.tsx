import type { UsageView } from "@pi-orb/protocol";
import { useEffect, useMemo, useState } from "react";
import { Chart } from "../components/Chart.tsx";
import { Icon } from "../components/Icons.tsx";
import { UsageOrbRankings } from "../components/UsageOrbRankings.tsx";
import { type ApiError, describeApiError, getModelUsage } from "../lib/api.ts";
import type { ChartSeriesActions } from "../lib/chart-spec.ts";
import {
  cacheShare,
  formatUsageCount,
  TOKEN_LABELS,
  totalTokens,
  type UsageBreakdown,
  type UsageMeasure,
  type UsagePeriod,
  usageAxis,
  usageBoundaries,
  usageRankings,
  usageTimeline,
} from "../lib/usage.ts";

const PERIODS: readonly [UsagePeriod, string][] = [
  ["day", "Last day"],
  ["week", "Week"],
  ["month", "Month"],
  ["six_months", "6 months"],
];
type ReadState =
  | { type: "loading" }
  | { type: "failed"; error: ApiError }
  | { type: "loaded"; data: UsageView };

interface UsageFilters {
  breakdown: UsageBreakdown;
  measure: UsageMeasure;
}
interface FilterProps {
  filters: UsageFilters;
  onFiltersChange: (filters: UsageFilters) => void;
}
function LoadedUsage({
  data,
  period,
  filters,
  onFiltersChange,
}: { data: UsageView; period: UsagePeriod } & FilterProps) {
  const { breakdown, measure } = filters;
  const timeline = useMemo(() => usageTimeline(data, breakdown), [data, breakdown]);
  const seriesActions = useMemo<ChartSeriesActions>(
    () =>
      new Map(
        [...timeline.targets].map(([name, target]) => [
          name,
          "orbId" in target
            ? { href: "/orbs/" + encodeURIComponent(target.orbId) }
            : { onSelect: () => onFiltersChange({ breakdown, measure: target.measure }) },
        ]),
      ),
    [timeline, breakdown, onFiltersChange],
  );
  const ranks = useMemo(() => usageRankings(data, measure), [data, measure]);
  const identity = useMemo(
    () => ({
      page: "usage",
      period,
      from: data.boundaries[0] ?? 0,
      to: data.boundaries.at(-1) ?? 0,
    }),
    [data, period],
  );
  const xAxis = useMemo(() => usageAxis(period, data.boundaries), [data, period]);
  const share = cacheShare(data.summary);
  const date = (at: number) =>
    new Date(at).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  const stats = [
    ["All tokens", formatUsageCount(totalTokens(data.summary))],
    ["Uncached input", formatUsageCount(data.summary.input)],
    ["Output", formatUsageCount(data.summary.output)],
    ["Prompt cache share", share === null ? "—" : (share * 100).toFixed(1) + "%"],
    ["Recorded calls", formatUsageCount(data.summary.calls)],
  ];
  return (
    <>
      <div className="usage-range">
        <span>
          {date(data.boundaries[0] ?? 0)} → {date(data.boundaries.at(-1) ?? 0)}
        </span>
      </div>
      <div className="usage-overview">
        <dl className="usage-summary">
          {stats.map(([name, value]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        {data.summary.calls === 0 ? (
          <p>No recorded calls.</p>
        ) : (
          <section className="usage-timeline">
            <header>
              <h2>Consumption over time</h2>
              <label>
                Breakdown{" "}
                <select
                  aria-label="Breakdown"
                  value={breakdown}
                  onChange={(event) =>
                    onFiltersChange({ ...filters, breakdown: event.target.value as UsageBreakdown })
                  }
                >
                  <option value="token_kind">Token kind</option>
                  <option value="use">Use</option>
                  <option value="model">Model</option>
                  <option value="orb">Orb</option>
                </select>
              </label>
            </header>
            <Chart
              spec={timeline.spec}
              identity={identity}
              height={280}
              xAxis={xAxis}
              yAxisFormat=".3~s"
              seriesActions={seriesActions}
            />
          </section>
        )}
      </div>
      {data.summary.calls > 0 && (
        <section className="usage-rankings">
          <header>
            <h2>Rankings</h2>
            <label>
              Measure{" "}
              <select
                aria-label="Measure"
                value={measure}
                onChange={(event) =>
                  onFiltersChange({ ...filters, measure: event.target.value as UsageMeasure })
                }
              >
                <option value="total">All tokens</option>
                {Object.entries(TOKEN_LABELS).map(([key, name]) => (
                  <option key={key} value={key}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          </header>
          <div className="usage-bars">
            {ranks.orbs.length > 0 && (
              <section>
                <h3>Top orbs</h3>
                <UsageOrbRankings rows={ranks.orbs} />
              </section>
            )}
            {ranks.uses !== null && (
              <section>
                <h3>Use</h3>
                <Chart spec={ranks.uses} identity={identity} />
              </section>
            )}
          </div>
        </section>
      )}
    </>
  );
}

function UsagePeriodView({
  period,
  onRetry,
  filters,
  onFiltersChange,
}: { period: UsagePeriod; onRetry: () => void } & FilterProps) {
  const [state, setState] = useState<ReadState>({ type: "loading" });
  useEffect(() => {
    const abort = new AbortController();
    let active = true;
    const boundaries = usageBoundaries(period, Date.now());
    void getModelUsage(boundaries, abort.signal).then((result) => {
      if (!active) return;
      setState(
        result.isOk()
          ? { type: "loaded", data: result.value }
          : { type: "failed", error: result.error },
      );
      console.debug("model usage read", {
        period,
        from: boundaries[0],
        to: boundaries.at(-1),
        outcome: result.isOk() ? "loaded" : "failed",
        ...(result.isOk() ? { calls: result.value.summary.calls } : { error: result.error }),
      });
    });
    return () => {
      active = false;
      abort.abort();
    };
  }, [period]);
  if (state.type === "loading") return <p role="status">Loading usage…</p>;
  if (state.type === "failed")
    return (
      <div className="banner banner-error" role="alert">
        {describeApiError(state.error)}{" "}
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  return (
    <LoadedUsage
      data={state.data}
      period={period}
      filters={filters}
      onFiltersChange={onFiltersChange}
    />
  );
}

export function UsagePage() {
  const [period, setPeriod] = useState<UsagePeriod>("week");
  const [attempt, setAttempt] = useState(0);
  const [filters, setFilters] = useState<UsageFilters>({
    breakdown: "token_kind",
    measure: "total",
  });
  return (
    <main className="usage-page">
      <header className="usage-header">
        <a className="icon-button" href="/" aria-label="Dashboard" title="Dashboard">
          <Icon name="back" />
        </a>
        <h1>Usage</h1>
      </header>
      <nav className="usage-periods" aria-label="Usage period">
        {PERIODS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={period === value}
            onClick={() => setPeriod(value)}
          >
            {label}
          </button>
        ))}
      </nav>
      <UsagePeriodView
        key={period + ":" + attempt}
        period={period}
        filters={filters}
        onFiltersChange={setFilters}
        onRetry={() => setAttempt((value) => value + 1)}
      />
    </main>
  );
}

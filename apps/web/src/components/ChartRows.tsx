import type { ChartSpec, DisplayDetailBody } from "@pi-orb/protocol";
import { Result, ResultAsync } from "neverthrow";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChartRenderError, MountedChart } from "../lib/chart-render.ts";
import { latestValue, seriesStyles } from "../lib/chart-spec.ts";
import { usePhoneLayout } from "../lib/use-phone-layout.ts";
import { ActivityRailRow } from "./ActivityRailRow.tsx";
import { CommittedBody, type DetailContext } from "./DetailBody.tsx";

const CHART_HEIGHT = 180;

type Renderer = typeof import("../lib/chart-render.ts");
const loadRenderer = () =>
  ResultAsync.fromPromise(
    import("../lib/chart-render.ts"),
    (cause): ChartRenderError => ({
      type: "chart_render_failed",
      message: cause instanceof Error ? cause.message : "Chart renderer failed to load",
    }),
  );

/**
 * vega-embed clears and reuses its target, and Vega reuses an existing <svg>, so two overlapping
 * mounts on one element can leave a finalized view on screen. Each mount owns a fresh host that its
 * cleanup detaches; a superseded mount can only ever render off-screen.
 */
function ownHost(container: HTMLElement): HTMLDivElement {
  const host = document.createElement("div");
  container.append(host);
  return host;
}

function sourceLabel(source: string): string | null {
  return Result.fromThrowable(
    () => new URL(source).hostname,
    () => null,
  )().unwrapOr(null);
}

function Sparkline({ spec }: { spec: ChartSpec }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const container = ref.current;
    if (container === null) return;
    const host = ownHost(container);
    let mounted: { finalize(): void } | undefined;
    let active = true;
    void loadRenderer()
      .andThen((renderer: Renderer) => renderer.mountSparkline(host, spec))
      .match(
        (result) => {
          if (active) mounted = result;
          else result.finalize();
        },
        (failure) => {
          if (active)
            console.debug("chart render", {
              outcome: "sparkline_failed",
              message: failure.message,
            });
        },
      );
    return () => {
      active = false;
      mounted?.finalize();
      host.remove();
    };
  }, [spec]);
  // vega-embed sizes its container to 100% of the parent, so the fixed width lives one level up.
  return (
    <span className="chart-strip-spark" aria-hidden="true">
      <span ref={ref} />
    </span>
  );
}

function Key({
  spec,
  highlighted,
  onHighlight,
}: {
  spec: Extract<ChartSpec, { kind: "line" }>;
  highlighted: string | null;
  onHighlight: (series: string | null) => void;
}) {
  const { colors, dash } = seriesStyles(spec.series.length);
  return (
    <div className="chart-key" data-highlighted={highlighted === null ? undefined : ""}>
      {spec.series.map((series, index) => (
        <span
          key={series.name}
          data-series={series.name}
          data-on={highlighted === series.name ? "" : undefined}
          onPointerEnter={() => onHighlight(series.name)}
          onPointerLeave={() => onHighlight(null)}
        >
          <svg width="14" height="2" aria-hidden="true">
            <line
              x1="0"
              y1="1"
              x2="14"
              y2="1"
              stroke={colors[index]}
              strokeWidth="2"
              strokeDasharray={dash[index]?.join(" ")}
            />
          </svg>
          {series.name}
        </span>
      ))}
    </div>
  );
}

function ChartView({
  spec,
  identity,
}: {
  spec: ChartSpec;
  identity: { orbId: string; recordId: string; detailKey: string; index: number };
}) {
  const phone = usePhoneLayout();
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<MountedChart | null>(null);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const container = ref.current;
    if (container === null) return;
    const host = ownHost(container);
    let active = true;
    const started = performance.now();
    setError(null);
    void loadRenderer()
      .andThen((renderer) =>
        renderer.mountChart(host, spec, {
          narrow: phone,
          height: CHART_HEIGHT,
          onHighlight: (series) => {
            if (active) setHighlighted(series);
          },
        }),
      )
      .match(
        (mounted) => {
          // A superseded mount (unmount, layout change) is discarded silently.
          if (!active) return mounted.finalize();
          chart.current = mounted;
          console.debug("chart render", {
            ...identity,
            outcome: "rendered",
            ms: Math.round(performance.now() - started),
          });
        },
        (failure) => {
          if (!active) return;
          setError(failure.message);
          console.debug("chart render", {
            ...identity,
            outcome: "failed",
            message: failure.message,
          });
        },
      );
    return () => {
      active = false;
      chart.current?.finalize();
      chart.current = null;
      host.remove();
    };
  }, [spec, phone, identity]);
  const source = spec.source === undefined ? null : sourceLabel(spec.source);
  return (
    <>
      {phone && spec.kind === "line" && spec.series.length > 1 && (
        <Key
          spec={spec}
          highlighted={highlighted}
          onHighlight={(series) => chart.current?.highlight(series)}
        />
      )}
      {error === null ? (
        <div className="chart-canvas" ref={ref} />
      ) : (
        <p className="chart-error" role="alert">
          Chart failed: {error}
        </p>
      )}
      {spec.source !== undefined && source !== null && (
        <footer>
          <a className="chart-source" href={spec.source} target="_blank" rel="noopener noreferrer">
            {source} ↗
          </a>
        </footer>
      )}
    </>
  );
}

function chartAt(body: DisplayDetailBody, index: number): ChartSpec | undefined {
  if (body.type !== "tool_result") return undefined;
  return body.content.flatMap((item) => (item.type === "chart" ? [item.spec] : []))[index];
}

/** Body that reports its spec up, so the folded summary can draw the sparkline. */
function LoadedChart({
  spec,
  onSpec,
  identity,
}: {
  spec: ChartSpec;
  onSpec: (spec: ChartSpec) => void;
  identity: { orbId: string; recordId: string; detailKey: string; index: number };
}) {
  useEffect(() => onSpec(spec), [spec, onSpec]);
  return <ChartView spec={spec} identity={identity} />;
}

function ChartRow({
  title,
  recordId,
  detailKey,
  index,
  context,
}: {
  title: string;
  recordId: string;
  detailKey: string;
  index: number;
  context: DetailContext;
}) {
  const [spec, setSpec] = useState<ChartSpec | null>(null);
  const value = spec === null ? null : latestValue(spec);
  const identity = useMemo(
    () => ({ orbId: context.orbId, recordId, detailKey, index }),
    [context.orbId, recordId, detailKey, index],
  );
  return (
    <ActivityRailRow
      className="chart-strip"
      label="chart"
      headline={title}
      defaultOpen
      {...(spec === null
        ? {}
        : {
            metric: (
              <span className="chart-strip-summary">
                <Sparkline spec={spec} />
                {value !== null && <span className="chart-strip-value">{value}</span>}
              </span>
            ),
          })}
    >
      <div className="chart-strip-body">
        <CommittedBody
          context={context}
          recordId={recordId}
          detailKey={detailKey}
          render={(body) => {
            const loaded = chartAt(body, index);
            return loaded === undefined ? (
              <p className="chart-error" role="alert">
                Chart unavailable.
              </p>
            ) : (
              <LoadedChart spec={loaded} onSpec={setSpec} identity={identity} />
            );
          }}
        />
      </div>
    </ActivityRailRow>
  );
}

/** One rail row per chart a tool result carries, open by default like tool images. */
export function ChartRows({
  titles,
  recordId,
  detailKey,
  context,
}: {
  titles: readonly string[];
  recordId: string;
  detailKey: string;
  context: DetailContext;
}) {
  return (
    <>
      {titles.map((title, index) => (
        <ChartRow
          // Charts of one result are append-only; position is their identity.
          key={index}
          title={title}
          recordId={recordId}
          detailKey={detailKey}
          index={index}
          context={context}
        />
      ))}
    </>
  );
}

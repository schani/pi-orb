import type { ChartSpec } from "@pi-orb/protocol";
import { Result, ResultAsync } from "neverthrow";
import { useEffect, useRef, useState } from "react";
import type { ChartRenderError, MountedChart } from "../lib/chart-render.ts";
import { type ChartSeriesActions, type ChartXAxis, seriesStyles } from "../lib/chart-spec.ts";
import { usePhoneLayout } from "../lib/use-phone-layout.ts";

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

export function Sparkline({ spec }: { spec: ChartSpec }) {
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
  seriesActions,
}: {
  seriesActions?: ChartSeriesActions;
  spec: Extract<ChartSpec, { kind: "line" }>;
  highlighted: string | null;
  onHighlight: (series: string | null) => void;
}) {
  const { colors, dash } = seriesStyles(spec.series.length);
  return (
    <div className="chart-key" data-highlighted={highlighted === null ? undefined : ""}>
      {spec.series.map((series, index) => {
        const action = seriesActions?.get(series.name);
        const props = {
          "data-series": series.name,
          "data-on": highlighted === series.name ? "" : undefined,
          onPointerEnter: () => onHighlight(series.name),
          onPointerLeave: () => onHighlight(null),
        };
        const content = (
          <>
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
          </>
        );
        const focus = {
          onFocus: () => onHighlight(series.name),
          onBlur: () => onHighlight(null),
        };
        return action === undefined ? (
          <span key={series.name} {...props}>
            {content}
          </span>
        ) : "href" in action ? (
          <a key={series.name} {...props} {...focus} href={action.href}>
            {content}
          </a>
        ) : (
          <button key={series.name} {...props} {...focus} type="button" onClick={action.onSelect}>
            {content}
          </button>
        );
      })}
    </div>
  );
}

export function Chart({
  spec,
  identity,
  height = CHART_HEIGHT,
  xAxis,
  yAxisFormat,
  seriesActions,
}: {
  spec: ChartSpec;
  identity: Readonly<Record<string, string | number>>;
  height?: number;
  xAxis?: ChartXAxis;
  yAxisFormat?: string;
  seriesActions?: ChartSeriesActions;
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
    setHighlighted(null);
    setError(null);
    void loadRenderer()
      .andThen((renderer) =>
        renderer.mountChart(host, spec, {
          narrow: phone,
          height,
          ...(xAxis === undefined ? {} : { xAxis }),
          ...(yAxisFormat === undefined ? {} : { yAxisFormat }),
          ...(seriesActions === undefined ? {} : { seriesActions }),
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
            title: spec.title,
            outcome: "rendered",
            ms: Math.round(performance.now() - started),
          });
        },
        (failure) => {
          if (!active) return;
          setError(failure.message);
          console.debug("chart render", {
            ...identity,
            title: spec.title,
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
  }, [spec, phone, identity, height, xAxis, yAxisFormat, seriesActions]);
  const source = spec.source === undefined ? null : sourceLabel(spec.source);
  return (
    <>
      {phone &&
        spec.kind === "line" &&
        (spec.series.length > 1 || (seriesActions?.size ?? 0) > 0) && (
          <Key
            spec={spec}
            highlighted={highlighted}
            {...(seriesActions === undefined ? {} : { seriesActions })}
            onHighlight={(series) => chart.current?.highlight(series)}
          />
        )}
      <div className="chart-canvas" ref={ref} hidden={error !== null} />
      {error !== null && (
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

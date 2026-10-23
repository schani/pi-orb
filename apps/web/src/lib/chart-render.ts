import type { ChartSpec } from "@pi-orb/protocol";
import { ResultAsync } from "neverthrow";
import embed, { type Config, type VisualizationSpec } from "vega-embed";
import {
  barChartSpec,
  CHART_CONFIG,
  type ChartSeriesActions,
  type ChartXAxis,
  compareSpec,
  heatmapSpec,
  histogramSpec,
  lineChartSpec,
  sparklineSpec,
  type TooltipRow,
  timelineSpec,
  tooltipRows,
  type VegaSpec,
} from "./chart-spec.ts";

/** Browser-only adapter around vega-embed; loaded lazily so Vega stays out of the main bundle. */

export interface ChartRenderError {
  readonly type: "chart_render_failed";
  readonly message: string;
}
export interface MountedChart {
  /** Isolate one series, or restore all with null. */
  highlight(series: string | null): void;
  finalize(): void;
}

const failure = (cause: unknown): ChartRenderError => ({
  type: "chart_render_failed",
  message: cause instanceof Error ? cause.message : "Chart rendering failed",
});

let tip: HTMLDivElement | null = null;
function tooltipElement(): HTMLDivElement {
  if (tip === null) {
    tip = document.createElement("div");
    tip.className = "chart-tip";
    tip.hidden = true;
    document.body.append(tip);
  }
  return tip;
}

function swatch(row: TooltipRow): SVGSVGElement | null {
  if (row.color === undefined) return null;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "2");
  svg.setAttribute("aria-hidden", "true");
  const line = document.createElementNS(ns, "line");
  for (const [name, value] of [
    ["x1", "0"],
    ["y1", "1"],
    ["x2", "14"],
    ["y2", "1"],
    ["stroke", row.color],
    ["stroke-width", "2"],
    ["stroke-dasharray", (row.dash ?? []).join(" ")],
  ] as const)
    line.setAttribute(name, value);
  svg.append(line);
  return svg;
}

function showTooltip(spec: ChartSpec, event: MouseEvent, value: unknown) {
  const element = tooltipElement();
  if (value === null || value === undefined || typeof value !== "object") {
    element.hidden = true;
    return;
  }
  const table = document.createElement("table");
  for (const row of tooltipRows(spec, value as Record<string, unknown>)) {
    const tr = table.insertRow();
    const label = tr.insertCell();
    label.className = "k";
    const key = swatch(row);
    if (key !== null) label.append(key);
    label.append(row.label);
    tr.insertCell().textContent = row.value;
  }
  element.replaceChildren(table);
  element.hidden = false;
  const box = element.getBoundingClientRect();
  let x = event.clientX + 14;
  let y = event.clientY + 14;
  if (x + box.width > window.innerWidth - 8) x = event.clientX - 14 - box.width;
  if (y + box.height > window.innerHeight - 8) y = event.clientY - 14 - box.height;
  element.style.left = `${x}px`;
  element.style.top = `${y}px`;
}

function render(
  container: HTMLElement,
  spec: VegaSpec,
  tooltip: (event: MouseEvent, value: unknown) => void,
) {
  // Vega caches text measurements; load the face before the first measurement.
  return ResultAsync.fromThrowable(
    () => document.fonts.load(`11px "${CHART_CONFIG.font}"`),
    failure,
  )().andThen(() =>
    ResultAsync.fromThrowable(
      () =>
        embed(container, spec as VisualizationSpec, {
          actions: false,
          renderer: "svg",
          config: CHART_CONFIG as unknown as Config,
          tooltip: (_handler: unknown, event: MouseEvent, _item: unknown, value: unknown) =>
            tooltip(event, value),
        }),
      failure,
    )(),
  );
}

export function mountChart(
  container: HTMLElement,
  spec: ChartSpec,
  options: {
    narrow: boolean;
    height: number;
    xAxis?: ChartXAxis;
    seriesActions?: ChartSeriesActions;
    onHighlight: (series: string | null) => void;
  },
): ResultAsync<MountedChart, ChartRenderError> {
  const vega =
    spec.kind === "bar"
      ? barChartSpec(spec)
      : spec.kind === "histogram"
        ? histogramSpec(spec, { narrow: options.narrow, height: options.height })
        : spec.kind === "timeline"
          ? timelineSpec(spec)
          : spec.kind === "heatmap"
            ? heatmapSpec(spec)
            : spec.kind === "compare"
              ? compareSpec(spec, { narrow: options.narrow })
              : lineChartSpec(spec, {
                  narrow: options.narrow,
                  height: options.height,
                  ...(options.xAxis === undefined ? {} : { xAxis: options.xAxis }),
                  ...(options.seriesActions === undefined
                    ? {}
                    : { seriesActions: options.seriesActions }),
                });
  return render(container, vega, (event, value) => showTooltip(spec, event, value)).map(
    ({ view }) => {
      const isolating =
        (spec.kind === "line" || spec.kind === "histogram") && spec.series.length > 1;
      const highlight = (series: string | null) => {
        if (!isolating) return;
        void ResultAsync.fromPromise(view.signal("hl", series).runAsync(), failure);
        options.onHighlight(series);
      };
      if (isolating) {
        // End labels and end dots carry `lv`, their placed label position.
        const series = (item: unknown) => {
          const datum = (item as { datum?: { s?: unknown; lv?: unknown } } | null)?.datum;
          return datum?.lv !== undefined && typeof datum.s === "string" ? datum.s : undefined;
        };
        view.addEventListener("pointerover", (_event, item) => {
          const name = series(item);
          if (name !== undefined) highlight(name);
        });
        view.addEventListener("pointerout", (_event, item) => {
          if (series(item) !== undefined) highlight(null);
        });
      }
      if (spec.kind === "line" && options.seriesActions !== undefined) {
        // This named mark preserves series order; never derive identity from rendered label text.
        container
          .querySelectorAll<SVGTextElement>("g.end_labels_marks text")
          .forEach((text, index) => {
            const name = spec.series[index]?.name;
            const action = name === undefined ? undefined : options.seriesActions?.get(name);
            if (name === undefined || action === undefined) return;
            const control = document.createElementNS("http://www.w3.org/2000/svg", "a");
            if ("href" in action) control.setAttribute("href", action.href);
            control.textContent = text.textContent;
            // Vega caches single-line text content, so isolation/resize retains this child.
            text.replaceChildren(control);
            text.setAttribute("role", "presentation");
            text.removeAttribute("aria-label");
            control.setAttribute("tabindex", "0");
            control.setAttribute("aria-label", name);
            control.setAttribute("role", "href" in action ? "link" : "button");
            control.classList.add("chart-series-action");
            text.style.cursor = "pointer";
            control.addEventListener("pointerenter", () => highlight(name));
            control.addEventListener("pointerleave", () => highlight(null));
            control.addEventListener("focus", () => highlight(name));
            control.addEventListener("blur", () => highlight(null));
            if ("onSelect" in action) {
              control.addEventListener("click", () => action.onSelect());
              control.addEventListener("keydown", (event) => {
                if (!(event instanceof KeyboardEvent)) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  if (!event.repeat) action.onSelect();
                }
              });
            }
          });
      }
      return {
        highlight,
        finalize: () => {
          view.finalize();
          tooltipElement().hidden = true;
        },
      };
    },
  );
}

export function mountSparkline(
  container: HTMLElement,
  spec: ChartSpec,
): ResultAsync<{ finalize(): void }, ChartRenderError> {
  return ResultAsync.fromPromise(
    embed(container, sparklineSpec(spec) as VisualizationSpec, {
      actions: false,
      renderer: "svg",
      config: { ...CHART_CONFIG, axis: { disable: true } } as unknown as Config,
      tooltip: false,
    }),
    failure,
  ).map(({ view }) => ({ finalize: () => view.finalize() }));
}

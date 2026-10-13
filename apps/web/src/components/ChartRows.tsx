import type { ChartSpec, DisplayDetailBody } from "@pi-orb/protocol";
import { useEffect, useMemo, useState } from "react";
import { latestValue } from "../lib/chart-spec.ts";
import { ActivityRailRow } from "./ActivityRailRow.tsx";
import { Chart, Sparkline } from "./Chart.tsx";
import { CommittedBody, type DetailContext } from "./DetailBody.tsx";

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
  return <Chart spec={spec} identity={identity} />;
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

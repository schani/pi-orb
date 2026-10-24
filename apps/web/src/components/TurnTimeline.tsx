import type { TimelineRow, TurnTimeline as TurnTimelineView } from "@pi-orb/protocol";
import {
  Fragment,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { getTurnTimeline } from "../lib/api.ts";
import {
  barSegments,
  callCell,
  clock,
  type Fact,
  failed,
  modelStyle,
  rowFacts,
  tipFacts,
} from "../lib/turn-timeline.ts";

const percent = (value: number) => `${Number((value * 100).toFixed(3))}%`;

function Bar({ row, from, span }: { row: TimelineRow; from: number; span: number }) {
  const left = (row.start - from) / span;
  const end = row.kind === "marker" ? row.start : row.end;
  if (end <= row.start)
    return (
      <div
        className={`timeline-bar timeline-instant${failed(row) ? " timeline-failed" : ""}`}
        style={{ left: percent(left) }}
      />
    );
  const style = { left: percent(left), width: percent(Math.max(0.004, (end - row.start) / span)) };
  if (row.kind === "tool")
    return (
      <div
        className={`timeline-bar timeline-tool${row.nested ? " timeline-nested" : ""}${
          row.status === "error"
            ? " timeline-failed"
            : row.status === "ok"
              ? ""
              : " timeline-stopped"
        }`}
        style={style}
      />
    );
  if (row.kind !== "model") return null;
  const kind = modelStyle(row);
  if (kind !== "llm") return <div className={`timeline-bar timeline-${kind}`} style={style} />;
  return (
    <div
      className={`timeline-bar timeline-llm${failed(row) ? " timeline-failed" : ""}`}
      style={style}
    >
      {barSegments(row).map((segment) => (
        <span
          key={segment.from}
          className={`timeline-${segment.phase}`}
          style={{ left: percent(segment.from), width: percent(segment.to - segment.from) }}
        />
      ))}
    </div>
  );
}

function FactList({ facts }: { facts: readonly Fact[] }) {
  return (
    <dl className="timeline-facts">
      {facts.map(([label, value, bad]) => (
        <Fragment key={label}>
          <dt>{label}</dt>
          <dd className={bad ? "error-text" : undefined}>{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** Rows in server order; `open` expands one row into its facts. */
export function TimelineTable({
  timeline,
  open,
  onToggle,
  onHover,
}: {
  timeline: TurnTimelineView;
  open: string | null;
  onToggle: (id: string) => void;
  onHover: (row: TimelineRow | null, event: PointerEvent) => void;
}) {
  const span =
    Math.max(
      timeline.start + 1,
      ...timeline.rows.map((row) => (row.kind === "marker" ? row.start : row.end)),
    ) - timeline.start;
  const byId = new Map(timeline.rows.map((row) => [row.id, row]));
  const target = (event: { target: EventTarget }) =>
    event.target instanceof Element
      ? byId.get(event.target.closest<HTMLElement>("tr[data-row]")?.dataset["row"] ?? "")
      : undefined;
  return (
    <table className="timeline-table">
      <colgroup>
        <col className="timeline-start-column" />
        <col className="timeline-call-column" />
        <col />
      </colgroup>
      <thead>
        <tr>
          <th>start</th>
          <th>call</th>
          <th />
        </tr>
      </thead>
      <tbody
        onClick={(event) => {
          const row = target(event);
          if (row !== undefined) onToggle(row.id);
        }}
        onKeyDown={(event) => {
          const row = target(event);
          if (row === undefined || (event.key !== "Enter" && event.key !== " ")) return;
          event.preventDefault();
          onToggle(row.id);
        }}
        onPointerMove={(event) => onHover(target(event) ?? null, event)}
        onPointerLeave={(event) => onHover(null, event)}
      >
        {timeline.rows.map((row) => {
          const { name, arg, failed: bad } = callCell(row);
          const facts = row.id === open ? rowFacts(row) : [];
          const side = row.kind === "model" && modelStyle(row) === "aux";
          const alert = row.kind === "marker" && row.marker === "alert";
          return [
            <tr
              key={row.id}
              className={`timeline-row${side ? " timeline-side" : ""}${alert ? " timeline-alert" : ""}${
                row.id === open ? " timeline-open" : ""
              }`}
              data-row={row.id}
              tabIndex={0}
              aria-expanded={row.id === open}
            >
              <td>{clock(row.start)}</td>
              <td className="timeline-call">
                {row.kind === "tool" && row.nested && <span className="timeline-indent">└</span>}
                <span className={bad && !alert ? "error-text" : undefined}>{name}</span>
                {arg !== "" && (
                  <>
                    {" "}
                    <span className="timeline-arg">{arg}</span>
                  </>
                )}
              </td>
              <td className="timeline-bars">
                <div className="timeline-track">
                  <Bar row={row} from={timeline.start} span={span} />
                </div>
              </td>
            </tr>,
            facts.length > 0 && (
              <tr key={`${row.id}:detail`} className="timeline-detail">
                <td colSpan={3}>
                  <FactList facts={facts} />
                </td>
              </tr>
            ),
          ];
        })}
      </tbody>
    </table>
  );
}

function Tip({ row, x, y }: { row: TimelineRow; x: number; y: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x + 14, top: y + 14 });
  useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect();
    if (rect === undefined) return;
    const left = x + 14 + rect.width > innerWidth - 8 ? x - rect.width - 14 : x + 14;
    const top = y + 14 + rect.height > innerHeight - 8 ? y - rect.height - 14 : y + 14;
    setPosition({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [x, y]);
  const { name, arg } = callCell(row);
  return (
    <div className="timeline-tip" ref={ref} style={position} role="tooltip">
      <b>{arg === "" ? name : `${name} ${arg}`}</b>
      <FactList facts={tipFacts(row)} />
    </div>
  );
}

/** One open row and a mouse-only tooltip over the table. */
function TimelineView({ timeline }: { timeline: TurnTimelineView }) {
  const [open, setOpen] = useState<string | null>(null);
  const [tip, setTip] = useState<{ row: TimelineRow; x: number; y: number } | null>(null);
  useEffect(() => {
    if (tip === null) return;
    const hide = () => setTip(null);
    window.addEventListener("scroll", hide, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", hide, { capture: true });
  }, [tip]);
  return (
    <>
      <TimelineTable
        timeline={timeline}
        open={open}
        onToggle={(id) => {
          setOpen((current) => (current === id ? null : id));
          setTip(null);
        }}
        onHover={(row, event) =>
          setTip(
            row === null || row.id === open || event.pointerType !== "mouse"
              ? null
              : { row, x: event.clientX, y: event.clientY },
          )
        }
      />
      {tip !== null && <Tip {...tip} />}
    </>
  );
}

export function TimelineFailure({ missing, onRetry }: { missing: boolean; onRetry: () => void }) {
  return missing ? (
    <p className="timeline-failure">This turn doesn’t exist.</p>
  ) : (
    <p className="timeline-failure error-text" role="alert">
      Timeline unavailable.{" "}
      <button type="button" onClick={onRetry}>
        Retry
      </button>
    </p>
  );
}

type Loaded =
  | { readonly key: string; readonly state: "ok"; readonly timeline: TurnTimelineView }
  | { readonly key: string; readonly state: "missing" | "failed" };

/**
 * The waterfall of one Pi turn (docs/web-ui.md "Pi transcript timeline"), replacing `children` (the
 * turn's activity) once it loads. `version` changes when the turn gains records, which reloads it
 * while the previous rows stay on screen.
 */
export function TurnTimeline({
  orbId,
  turnId,
  version,
  children,
}: {
  orbId: string;
  turnId: string;
  version: string;
  children: ReactNode;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = `${orbId}\n${turnId}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new turn record or Retry reloads the same turn.
  useEffect(() => {
    const controller = new AbortController();
    void getTurnTimeline(orbId, turnId, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.isOk()) {
        setLoaded({ key, state: "ok", timeline: result.value });
        return;
      }
      console.debug("turn timeline", { orbId, turnId, error: result.error.type });
      setLoaded({
        key,
        state: result.error.type === "http" && result.error.status === 404 ? "missing" : "failed",
      });
    });
    return () => controller.abort();
  }, [orbId, turnId, key, version, attempt]);
  const current = loaded?.key === key ? loaded : null;
  return (
    <div className="turn-timeline" aria-busy={current === null}>
      {current?.state === "ok" ? (
        <TimelineView timeline={current.timeline} />
      ) : current !== null ? (
        <TimelineFailure
          missing={current.state === "missing"}
          onRetry={() => setAttempt((value) => value + 1)}
        />
      ) : (
        children
      )}
    </div>
  );
}

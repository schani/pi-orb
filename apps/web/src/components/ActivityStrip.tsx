import { Fragment, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { ActivityRailOpen, ActivityRailRow } from "./ActivityRailRow.tsx";

export type ActivityStepState = "thinking" | "success" | "notification" | "failed" | "running";

export interface ActivityStep {
  key: string;
  /** Detail identity shared by a step's live and persisted forms, before alias resolution. */
  identity: string;
  state: ActivityStepState;
  label: string;
  headline: string;
  node: ReactNode;
}

/** A rendered turn child; only those carrying a step can join a strip. */
export interface ActivityItem {
  key: string;
  node: ReactNode;
  step?: ActivityStep;
}

/** The transcript's open-disclosure memory, which outlives remounts at the live-to-history handoff. */
export interface ActivityOpenMemory {
  aliases: ReadonlyMap<string, string>;
  opened: Set<string>;
}

const DOT_WIDTH = 12;
const MORE_WIDTH = 44;

/** Folds each maximal run of two or more steps into one strip; other items render unchanged. */
export function groupActivity(
  items: readonly ActivityItem[],
  memory: ActivityOpenMemory | null = null,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let run: ActivityStep[] = [];
  let strips = 0;
  const flush = () => {
    const first = run[0];
    if (run.length === 1 && first !== undefined)
      nodes.push(<Fragment key={first.key}>{first.node}</Fragment>);
    else if (first !== undefined)
      nodes.push(<ActivityStrip key={`strip:${strips++}`} steps={run} memory={memory} />);
    run = [];
  };
  for (const item of items) {
    if (item.step !== undefined) {
      run.push(item.step);
      continue;
    }
    flush();
    nodes.push(<Fragment key={item.key}>{item.node}</Fragment>);
  }
  flush();
  return nodes;
}

interface Tip {
  step: ActivityStep;
  left: number;
  top: number;
}

export function ActivityStrip({
  steps,
  memory = null,
}: {
  steps: readonly ActivityStep[];
  memory?: ActivityOpenMemory | null;
}) {
  const dotsRef = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(0);
  const remembered = steps.map(
    (step) => `strip:${memory?.aliases.get(step.identity) ?? step.identity}`,
  );
  const [open, setOpen] = useState(() => remembered.some((id) => memory?.opened.has(id)));
  // Once opened, rows stay mounted while closed so in-flight headlines still land, as in a category.
  const [mounted, setMounted] = useState(open);
  const [picked, setPicked] = useState<string | null>(null);
  const remember = (value: boolean) => {
    for (const id of remembered) {
      if (value) memory?.opened.add(id);
      else memory?.opened.delete(id);
    }
  };
  const [tip, setTip] = useState<Tip | null>(null);

  useLayoutEffect(() => {
    const element = dotsRef.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(element.getBoundingClientRect().width));
    observer.observe(element);
    setWidth(element.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  const fits = width === 0 || steps.length * DOT_WIDTH <= width;
  const capacity = fits ? steps.length : Math.max(1, Math.floor((width - MORE_WIDTH) / DOT_WIDTH));
  const hidden = steps.length - capacity;
  const shown = steps.slice(hidden);
  const pickedStep = picked === null ? undefined : steps.find((step) => step.key === picked);

  return (
    <ActivityRailRow
      className="activity-strip"
      label="activity"
      strip={
        <span className="activity-strip-dots" ref={dotsRef}>
          {hidden > 0 && <span className="activity-strip-more">+{hidden}</span>}
          {shown.map((step) => (
            <button
              type="button"
              tabIndex={-1}
              key={step.key}
              className={`activity-strip-dot activity-strip-${step.state}${
                step.key === picked ? " activity-strip-picked" : ""
              }`}
              data-step={step.state}
              aria-label={step.headline === "" ? step.label : `${step.label} · ${step.headline}`}
              aria-pressed={step.key === picked}
              onMouseLeave={() => setTip(null)}
              onMouseEnter={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setTip({ step, left: rect.left, top: rect.top });
              }}
              onClick={(event) => {
                event.preventDefault();
                remember(false);
                setOpen(false);
                setPicked((current) => (current === step.key ? null : step.key));
              }}
            />
          ))}
          {tip !== null && (
            <span
              className="activity-strip-tip"
              role="tooltip"
              style={{
                left: Math.max(4, tip.left - 16),
                top: tip.top - 24,
                maxWidth: `min(60ch, calc(100vw - ${Math.max(4, tip.left - 16) + 8}px))`,
              }}
            >
              <span className={`activity-strip-tip-label activity-strip-${tip.step.state}`}>
                {tip.step.label}
              </span>
              {tip.step.headline !== "" && ` · ${tip.step.headline}`}
            </span>
          )}
        </span>
      }
      metric={steps.length}
      state={steps.some((step) => step.state === "running") ? "running" : "neutral"}
      defaultOpen={open || pickedStep !== undefined}
      onToggle={(value) => {
        // Opening for a picked dot keeps that single step; the summary opens every step.
        if (value && pickedStep !== undefined) return;
        remember(value);
        setOpen(value);
        if (value) setMounted(true);
        if (!value) setPicked(null);
      }}
    >
      {(mounted || pickedStep !== undefined) && (
        <div className="activity-strip-body">
          {pickedStep !== undefined ? (
            <ActivityRailOpen key={pickedStep.key} value={true}>
              {pickedStep.node}
            </ActivityRailOpen>
          ) : (
            steps.map((step) => <Fragment key={step.key}>{step.node}</Fragment>)
          )}
        </div>
      )}
    </ActivityRailRow>
  );
}

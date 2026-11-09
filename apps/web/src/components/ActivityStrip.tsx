import {
  cloneElement,
  Fragment,
  isValidElement,
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ActivityHeadlinePreview } from "../lib/use-activity-headline.tsx";
import { ActivityRailHidden, ActivityRailOpen, ActivityRailRow } from "./ActivityRailRow.tsx";

export type ActivityStepState =
  | "thinking"
  | "success"
  | "notification"
  | "failed"
  | "running"
  | "restart";

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
/** Material "refresh" with a widened gap at the arc start, drawn in the success dot's box. */
const RESTART_PATH =
  "M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8A8 8 0 0 0 19.42 15L17.20 15A6 6 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z";
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
  key: string;
  left: number;
  top: number;
}
type Preview = { text: string | undefined; failed: boolean };

function StepOwner({
  step,
  target,
  picked,
  publish,
}: {
  step: ActivityStep;
  target: HTMLElement | null;
  picked: string | null;
  publish: (key: string, text: string | undefined, failed: boolean) => void;
}) {
  const update = useCallback(
    (text: string | undefined, failed: boolean) => publish(step.key, text, failed),
    [publish, step.key],
  );
  const hidden = picked !== null && picked !== step.key;
  const node =
    isValidElement<{ hidden?: boolean }>(step.node) && typeof step.node.type === "string"
      ? cloneElement(step.node, { hidden })
      : step.node;
  return (
    <ActivityHeadlinePreview value={{ target, publish: update }}>
      <ActivityRailHidden value={hidden}>
        <ActivityRailOpen value={picked === step.key}>{node}</ActivityRailOpen>
      </ActivityRailHidden>
    </ActivityHeadlinePreview>
  );
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
  const [tipHeader, setTipHeader] = useState<HTMLSpanElement | null>(null);
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set());
  const visit = (key: string) =>
    setVisited((current) => (current.has(key) ? current : new Set(current).add(key)));
  const [previews, setPreviews] = useState<ReadonlyMap<string, Preview>>(() => new Map());
  const publish = useCallback((key: string, text: string | undefined, failed: boolean) => {
    setPreviews((current) => {
      const previous = current.get(key);
      if (previous?.text === text && (previous?.failed ?? false) === failed) return current;
      return new Map(current).set(key, { text, failed });
    });
  }, []);
  const headline = (step: ActivityStep) => {
    const preview = previews.get(step.key);
    return preview?.failed ? "Summary unavailable." : (preview?.text ?? step.headline);
  };

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
  const tipStep = tip === null ? undefined : steps.find((step) => step.key === tip.key);

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
              aria-label={headline(step) === "" ? step.label : `${step.label} · ${headline(step)}`}
              aria-pressed={step.key === picked}
              onMouseLeave={() => setTip(null)}
              onMouseEnter={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                visit(step.key);
                setTip({ key: step.key, left: rect.left, top: rect.top });
              }}
              onClick={(event) => {
                event.preventDefault();
                visit(step.key);
                remember(false);
                setOpen(false);
                setPicked((current) => (current === step.key ? null : step.key));
              }}
            >
              {step.state === "restart" && (
                <svg
                  className="activity-strip-glyph"
                  viewBox="3.7 3.7 16.6 16.6"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path
                    d={RESTART_PATH}
                    fill="currentColor"
                    stroke="currentColor"
                    strokeWidth="0.6"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </button>
          ))}
          {tip !== null && tipStep !== undefined && (
            <span
              ref={setTipHeader}
              className="activity-strip-tip"
              role="tooltip"
              style={{
                left: Math.max(4, tip.left - 16),
                top: tip.top - 24,
                maxWidth: `min(60ch, calc(100vw - ${Math.max(4, tip.left - 16) + 8}px))`,
              }}
            >
              <span className={`activity-strip-tip-label activity-strip-${tipStep.state}`}>
                {tipStep.label}
              </span>
              {headline(tipStep) !== "" && ` · ${headline(tipStep)}`}
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
      <div className="activity-strip-body">
        {steps.map((step) =>
          mounted || visited.has(step.key) || picked === step.key ? (
            <StepOwner
              key={step.key}
              step={step}
              target={tip?.key === step.key ? tipHeader : null}
              picked={pickedStep?.key ?? null}
              publish={publish}
            />
          ) : null,
        )}
      </div>
    </ActivityRailRow>
  );
}

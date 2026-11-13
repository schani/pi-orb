import {
  githubLinkKind,
  githubLinkRef,
  type OrbLinkCheck,
  type OrbLinksResponse,
} from "@pi-orb/protocol";
import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";
import type { ApiError } from "../lib/api.ts";
import { describeApiError, listOrbLinks, removeOrbLink } from "../lib/api.ts";
import { stripTipStyle } from "../lib/strip-tip.ts";
import { Icon } from "./Icons.tsx";

const POLL_INTERVAL_MS = 15_000;
type Result = OrbLinkCheck["result"];

/** Activity-strip dot states; `pending` is gray like a step that has not started. */
const STATE: Record<Result, string> = {
  passed: "",
  failed: "activity-strip-failed",
  running: "activity-strip-running",
  pending: "orb-link-pending",
};
const dotClass = (result: Result) => `activity-strip-dot ${STATE[result]}`.trim();

interface Tip {
  readonly label: string;
  readonly status: string;
  readonly result: Result;
  readonly style: CSSProperties;
}

function overall(checks: readonly OrbLinkCheck[]): Result {
  for (const result of ["failed", "running", "pending"] as const)
    if (checks.some((check) => check.result === result)) return result;
  return checks.length > 0 ? "passed" : "pending";
}

const CLOSED = new Set(["merged", "closed", "passed", "failed"]);
const KIND_ORDER = ["pull", "issue", "run"];
type Link = OrbLinksResponse["items"][number];

/** Open or running first, then closed; within each, pull requests, issues, runs; then oldest first. */
const rank = (link: Link) =>
  (CLOSED.has(link.github?.status ?? "") ? KIND_ORDER.length : 0) +
  KIND_ORDER.indexOf(githubLinkKind(link.url) ?? "run");

/** GitHub's state colours: open green, draft grey, merged or completed purple, closed red. */
function tone(link: Link): string | null {
  const status = link.github?.status;
  if (status === undefined) return null;
  if (status === "merged" || (status === "closed" && githubLinkKind(link.url) === "issue"))
    return "done";
  if (status === "closed" || status === "failed") return "bad";
  if (status === "running" || status === "queued") return "warn";
  return status === "draft" ? "muted" : "ok";
}

const two = (value: number) => String(value).padStart(2, "0");
const duration = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${two(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${two(Math.floor(seconds / 60) % 60)}m`;
};
const percent = (value: number) => `${Number((value * 100).toFixed(3))}%`;

interface Span {
  readonly name: string;
  readonly result: Result;
  /** Ready to run but waiting for a runner, from `queued` until now; only known while pending. */
  readonly queued: number | null;
  readonly started: number | null;
  readonly finished: number | null;
}

interface BarTip {
  readonly span: Span;
  readonly style: CSSProperties;
}

/**
 * A check on the shared track. While pending, GitHub's `startedAt` is when the job became ready, so
 * it waits for a runner from then until now; once started, that wait is no longer reported.
 */
function checkSpan(check: OrbLinkCheck, now: number): Span {
  const pending = check.result === "pending";
  return {
    name: check.name,
    result: check.result,
    queued: pending ? check.startedAt : null,
    started: pending ? null : check.startedAt,
    finished: check.completedAt ?? (pending || check.result === "running" ? now : null),
  };
}

const ran = (span: Span) =>
  span.started === null || span.finished === null ? null : span.finished - span.started;

function tipText(span: Span): string {
  const facts = [
    span.queued === null
      ? null
      : `waiting for a runner ${duration((span.finished ?? span.queued) - span.queued)}`,
    ran(span) === null ? null : `ran ${duration(ran(span) ?? 0)}`,
  ].filter((fact): fact is string => fact !== null);
  return facts.length === 0 ? "" : ` · ${facts.join(" · ")}`;
}

/** CI waterfall (Pi turn waterfall language): runner wait outlined, then the run; steps unfold. */
function Waterfall({ checks, now }: { checks: readonly OrbLinkCheck[]; now: number }) {
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const [tip, setTip] = useState<BarTip | null>(null);
  const spans = checks.map((check) => checkSpan(check, now));
  const from = Math.min(
    ...spans.map((span) => span.queued ?? span.started).filter((at): at is number => at !== null),
    Number.POSITIVE_INFINITY,
  );
  const to = Math.max(
    from + 1,
    ...spans.map((span) => span.finished).filter((at): at is number => at !== null),
  );
  const at = (ms: number) => percent((ms - from) / (to - from));
  const width = (ms: number) => percent(Math.max(0.004, ms / (to - from)));
  const toggle = (index: number) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(index)) next.add(index);
      return next;
    });
  const row = (span: Span, key: string, name: ReactNode, unfold?: () => void) => {
    const onToggle = (event: MouseEvent | KeyboardEvent) => {
      if (unfold === undefined || (event.target instanceof Element && event.target.closest("a")))
        return;
      if ("key" in event && event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      unfold();
    };
    const length = ran(span);
    return (
      <tr
        key={key}
        className={unfold === undefined ? undefined : "link-timeline-unfolds"}
        tabIndex={unfold === undefined ? undefined : 0}
        aria-expanded={unfold === undefined ? undefined : open.has(Number(key))}
        onClick={onToggle}
        onKeyDown={onToggle}
      >
        <td className="link-timeline-name">{name}</td>
        <td className="link-timeline-dot">
          <span className={dotClass(span.result)} />
        </td>
        <td
          className="link-timeline-bars"
          onMouseMove={(event) => {
            const top = event.currentTarget.getBoundingClientRect().top;
            const point = { left: event.clientX, right: event.clientX, top };
            setTip({ span, style: stripTipStyle(point, document.documentElement.clientWidth) });
          }}
          onMouseLeave={() => setTip(null)}
        >
          <div className="link-timeline-track">
            {span.queued !== null && span.finished !== null && (
              <span
                className="link-timeline-bar link-timeline-queued"
                style={{ left: at(span.queued), width: width(span.finished - span.queued) }}
              />
            )}
            {span.started !== null && length !== null && (
              <span
                className={`link-timeline-bar link-timeline-${span.result}`}
                style={{ left: at(span.started), width: width(length) }}
              />
            )}
          </div>
        </td>
        <td className="link-timeline-duration">{length === null ? "" : duration(length)}</td>
      </tr>
    );
  };
  return (
    <>
      <table className="link-timeline">
        <tbody>
          {checks.map((check, index) => [
            row(
              spans[index] ?? checkSpan(check, now),
              String(index),
              check.url === null ? (
                check.name
              ) : (
                <a href={check.url} target="_blank" rel="noreferrer">
                  {check.name}
                </a>
              ),
              check.steps.length > 0 ? () => toggle(index) : undefined,
            ),
            ...(open.has(index)
              ? check.steps.map((step, stepIndex) =>
                  row(
                    {
                      name: step.name,
                      result: step.result,
                      queued: null,
                      started: step.startedAt,
                      finished: step.completedAt ?? (step.result === "running" ? now : null),
                    },
                    `${index}:${stepIndex}`,
                    <>
                      <span className="link-timeline-indent">└</span>
                      {step.name}
                    </>,
                  ),
                )
              : []),
          ])}
        </tbody>
      </table>
      {tip !== null && (
        <span className="activity-strip-tip" role="tooltip" style={tip.style}>
          {tip.span.name} ·{" "}
          <span className={`activity-strip-tip-label ${STATE[tip.span.result]}`.trim()}>
            {tip.span.result}
          </span>
          {tipText(tip.span)}
        </span>
      )}
    </>
  );
}

export function OrbLinksDrawer({
  links,
  error,
  onRemove,
}: {
  links: OrbLinksResponse | null;
  error: ApiError | null;
  onRemove: (url: string) => void;
}) {
  const [tip, setTip] = useState<Tip | null>(null);
  const now = Date.now();
  if (links === null && error === null) return null;
  if (links?.items.length === 0 && links.githubError === null && error === null) return null;
  const items = [...(links?.items ?? [])].sort((a, b) => rank(a) - rank(b));
  const refs = items.map((link) => githubLinkRef(link.url, links?.repository ?? null));
  const style = {
    "--orb-link-ref": `${Math.max(0, ...refs.map((ref) => ref.length))}ch`,
    "--orb-link-strip": `${Math.max(0, ...items.map((link) => link.github?.checks.length ?? 0)) * 12}px`,
  } as CSSProperties;
  const dot = (result: Result, label: string, status: string, key: string | number) => (
    <span
      key={key}
      className={dotClass(result)}
      role="img"
      aria-label={status === "" ? label : `${label} · ${status}`}
      onMouseEnter={(event) => {
        const style = stripTipStyle(
          event.currentTarget.getBoundingClientRect(),
          document.documentElement.clientWidth,
        );
        setTip({ label, status, result, style });
      }}
      onMouseLeave={() => setTip(null)}
    />
  );
  return (
    <details className="orb-links activity-rail-row" open={error !== null || undefined}>
      <summary>
        <span className="activity-rail-marker" aria-hidden="true" />
        <span className="activity-rail-summary">links</span>
        <span className="orb-link-strip">
          {items.map((link, index) =>
            dot(
              overall(link.github?.checks ?? []),
              refs[index] ?? link.url,
              link.github?.status ?? "",
              link.url,
            ),
          )}
        </span>
        {tip !== null && (
          <span className="activity-strip-tip" role="tooltip" style={tip.style}>
            {tip.label}
            {tip.status !== "" && (
              <>
                {" · "}
                <span className={`activity-strip-tip-label ${STATE[tip.result]}`.trim()}>
                  {tip.status}
                </span>
              </>
            )}
          </span>
        )}
      </summary>
      <div className="orb-links-roster" style={style}>
        {error !== null && <p className="error-text">{describeApiError(error)}</p>}
        {links?.githubError != null && <p className="error-text">{links.githubError}</p>}
        {items.map((link, index) => (
          <details className="orb-link" key={link.url}>
            <summary>
              <span
                className={["orb-link-kind", tone(link) && `orb-link-${tone(link)}`]
                  .filter(Boolean)
                  .join(" ")}
              >
                <Icon name={githubLinkKind(link.url) ?? "pull"} />
              </span>
              <a href={link.url} target="_blank" rel="noreferrer">
                {refs[index]}
              </a>
              <span className="orb-link-title">{link.github?.title}</span>
              <span className="orb-link-strip">
                {link.github?.checks.map((check, i) =>
                  dot(check.result, check.name, check.result, i),
                )}
              </span>
              <span className="orb-link-status">{link.github?.status}</span>
              <button
                type="button"
                className="icon-button danger"
                aria-label="Remove link"
                title="remove"
                onClick={(event) => {
                  event.preventDefault();
                  onRemove(link.url);
                }}
              >
                <Icon name="bin" />
              </button>
            </summary>
            {(link.github?.checks.length ?? 0) > 0 && (
              <Waterfall checks={link.github?.checks ?? []} now={now} />
            )}
          </details>
        ))}
      </div>
    </details>
  );
}

/** The orb's in-progress GitHub links (docs/orb-links.md). */
export function OrbLinks({ orbId }: { orbId: string }) {
  const [links, setLinks] = useState<OrbLinksResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [generation, setGeneration] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: generation forces an immediate re-read
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const result = await listOrbLinks(orbId);
      if (cancelled) return;
      if (result.isOk()) {
        setLinks(result.value);
        setError(null);
      } else if (!(result.error.type === "http" && result.error.status === 404))
        setError(result.error);
    };
    void poll();
    const timer = window.setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [orbId, generation]);
  const remove = useCallback(
    async (url: string) => {
      const result = await removeOrbLink(orbId, url);
      if (result.isErr()) setError(result.error);
      else setGeneration((value) => value + 1);
    },
    [orbId],
  );
  return <OrbLinksDrawer links={links} error={error} onRemove={(url) => void remove(url)} />;
}

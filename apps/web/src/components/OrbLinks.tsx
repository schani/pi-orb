import { githubLinkRef, type OrbLinkCheck, type OrbLinksResponse } from "@pi-orb/protocol";
import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
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

const two = (value: number) => String(value).padStart(2, "0");
const clock = (ms: number) => {
  const at = new Date(ms);
  return `${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`;
};
const duration = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${two(seconds % 60)}s`;
};
const percent = (value: number) => `${Number((value * 100).toFixed(3))}%`;

/** CI waterfall (PR turn waterfall language): queued outline, then the run; steps unfold. */
function Waterfall({ checks, now }: { checks: readonly OrbLinkCheck[]; now: number }) {
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const begin = (check: OrbLinkCheck) => check.queuedAt ?? check.startedAt;
  const end = (check: OrbLinkCheck) =>
    check.completedAt ?? (check.result === "running" || check.result === "pending" ? now : null);
  const from = Math.min(
    ...checks.map(begin).filter((at): at is number => at !== null),
    Number.POSITIVE_INFINITY,
  );
  const to = Math.max(from + 1, ...checks.map(end).filter((at): at is number => at !== null));
  const span = to - from;
  const at = (ms: number) => percent((ms - from) / span);
  const width = (ms: number) => percent(Math.max(0.004, ms / span));
  const toggle = (index: number) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(index)) next.add(index);
      return next;
    });
  return (
    <table className="link-timeline">
      <colgroup>
        <col className="link-timeline-start" />
        <col className="link-timeline-check" />
        <col />
      </colgroup>
      <thead>
        <tr>
          <th>start</th>
          <th>check</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {checks.map((check, index) => {
          const queued = begin(check);
          const finish = end(check);
          const started = check.startedAt;
          const unfold = check.steps.length > 0;
          const onToggle = (event: MouseEvent | KeyboardEvent) => {
            if (!unfold || (event.target instanceof Element && event.target.closest("a"))) return;
            if ("key" in event && event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            toggle(index);
          };
          return [
            <tr
              key={index}
              className={unfold ? "link-timeline-unfolds" : undefined}
              tabIndex={unfold ? 0 : undefined}
              aria-expanded={unfold ? open.has(index) : undefined}
              onClick={onToggle}
              onKeyDown={onToggle}
            >
              <td>{started === null ? "" : clock(started)}</td>
              <td className="link-timeline-call">
                {check.url === null ? (
                  <span>{check.name}</span>
                ) : (
                  <a href={check.url} target="_blank" rel="noreferrer">
                    {check.name}
                  </a>
                )}
                {started !== null && finish !== null && (
                  <span className="link-timeline-arg"> {duration(finish - started)}</span>
                )}
              </td>
              <td className="link-timeline-bars">
                <div className="link-timeline-track">
                  {queued !== null && finish !== null && (
                    <>
                      <span
                        className="link-timeline-bar link-timeline-queued"
                        style={{ left: at(queued), width: width((started ?? finish) - queued) }}
                      />
                      {started !== null && (
                        <span
                          className={`link-timeline-bar link-timeline-${check.result}`}
                          style={{ left: at(started), width: width(finish - started) }}
                        />
                      )}
                    </>
                  )}
                </div>
              </td>
            </tr>,
            ...(open.has(index)
              ? check.steps.map((step, stepIndex) => {
                  const stepEnd = step.completedAt ?? (step.result === "running" ? now : null);
                  return (
                    <tr key={`${index}:${stepIndex}`} className="link-timeline-step">
                      <td>{step.startedAt === null ? "" : clock(step.startedAt)}</td>
                      <td className="link-timeline-call">
                        <span className="link-timeline-indent">└</span>
                        <span className={step.result === "failed" ? "error-text" : undefined}>
                          {step.name}
                        </span>
                        {step.startedAt !== null && stepEnd !== null && (
                          <span className="link-timeline-arg">
                            {" "}
                            {duration(stepEnd - step.startedAt)}
                          </span>
                        )}
                      </td>
                      <td className="link-timeline-bars">
                        <div className="link-timeline-track">
                          {step.startedAt !== null && stepEnd !== null && (
                            <span
                              className={`link-timeline-bar link-timeline-${step.result}`}
                              style={{
                                left: at(step.startedAt),
                                width: width(stepEnd - step.startedAt),
                              }}
                            />
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              : []),
          ];
        })}
      </tbody>
    </table>
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
  const items = links?.items ?? [];
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

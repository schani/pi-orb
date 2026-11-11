import { githubLinkRef, type OrbLinkCheck, type OrbLinksResponse } from "@pi-orb/protocol";
import { type CSSProperties, useCallback, useEffect, useState } from "react";
import type { ApiError } from "../lib/api.ts";
import { describeApiError, listOrbLinks, removeOrbLink } from "../lib/api.ts";
import { stripTipStyle } from "../lib/strip-tip.ts";

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
            <span className={`activity-strip-tip-label ${STATE[tip.result]}`.trim()}>
              {tip.label}
            </span>
            {tip.status !== "" && ` · ${tip.status}`}
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
            </summary>
            <div className="orb-link-body">
              {link.github?.checks.map((check, i) => (
                <div className="orb-link-check" key={i}>
                  <span className={dotClass(check.result)} />
                  <span>{check.name}</span>
                  <span className={`orb-link-result-${check.result}`}>{check.result}</span>
                </div>
              ))}
              <button type="button" className="orb-link-remove" onClick={() => onRemove(link.url)}>
                remove
              </button>
            </div>
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

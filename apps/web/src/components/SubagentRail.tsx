import type { ActiveSubagent } from "@pi-orb/protocol";
import { useLayoutEffect, useRef, useState } from "react";

/** Current runtime work only; durable child receipts remain in HistoryView. */
export function SubagentRail({ agents }: { agents: readonly ActiveSubagent[] }) {
  const summaryRef = useRef<HTMLElement>(null);
  const [maxHeight, setMaxHeight] = useState(160);
  useLayoutEffect(() => {
    const summary = summaryRef.current;
    const main = summary?.closest<HTMLElement>(".orb-main");
    const composer = main?.querySelector<HTMLElement>(".composer");
    if (!summary || !main || !composer) return;
    const update = () => {
      // Share remaining vertical space with the terminal, even with a phone
      // keyboard/editor and the overflow action row open simultaneously.
      const available =
        Math.min(window.innerHeight, composer.getBoundingClientRect().top) -
        summary.getBoundingClientRect().bottom;
      setMaxHeight(Math.max(0, Math.min(160, available / 2)));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(summary);
    observer.observe(main);
    observer.observe(composer);
    window.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  const phases = ["running", "queued", "finishing"] as const;
  return (
    <details className="subagent-live-rail activity-rail-row">
      <summary ref={summaryRef}>
        <span className="activity-rail-marker" aria-hidden="true" />
        <span className="activity-rail-summary">subagents</span>
        <span className="subagent-counts" aria-live="polite">
          {phases.map((phase) => {
            const count = agents.filter((agent) => agent.phase === phase).length;
            return count > 0 ? (
              <span key={phase} className={`subagent-phase-${phase}`}>
                {count} {phase}
              </span>
            ) : null;
          })}
        </span>
      </summary>
      <div className="subagent-roster" style={{ maxHeight }}>
        {agents.map((agent) => (
          <details key={agent.id}>
            <summary>
              <span className="activity-rail-marker" aria-hidden="true" />
              <span>{agent.description}</span>
              <span className={`subagent-phase-${agent.phase}`}>{agent.phase}</span>
            </summary>
            <div className="subagent-identity">{agent.id}</div>
          </details>
        ))}
      </div>
    </details>
  );
}

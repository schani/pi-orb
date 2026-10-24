import type { ActiveSubagent } from "@pi-orb/protocol";
import { useLayoutEffect, useRef, useState } from "react";
import { useActivityHeadline } from "../lib/use-activity-headline.tsx";
import type { DetailContext } from "./DetailBody.tsx";

type Context = Pick<DetailContext, "orbId" | "sessionId">;
function SubagentRow({ agent, context }: { agent: ActiveSubagent; context: Context }) {
  const { headerRef, headline } = useActivityHeadline(
    agent.taskRecordId === undefined
      ? undefined
      : {
          recordId: agent.taskRecordId,
          detailKey: `${agent.taskRecordId}:task`,
          headline: null,
        },
    context,
    agent.description,
  );
  return (
    <li ref={headerRef}>
      <span>{headline}</span>
      <span className={`subagent-phase-${agent.phase}`}>{agent.phase}</span>
    </li>
  );
}

/** Current runtime work only; durable child receipts remain in HistoryView. */
export function SubagentRail({
  agents,
  context,
  kind = "subagent",
}: {
  agents: readonly ActiveSubagent[];
  context: Context;
  kind?: "subagent" | "shell";
}) {
  const roster = agents.filter((agent) => (agent.kind ?? "subagent") === kind);
  const visible = roster.length > 0;
  const summaryRef = useRef<HTMLElement>(null);
  const [maxHeight, setMaxHeight] = useState(160);
  useLayoutEffect(() => {
    if (!visible) return;
    const summary = summaryRef.current;
    const main = summary?.closest<HTMLElement>(".orb-main");
    const header = summary?.closest<HTMLElement>(".orb-header-stack");
    const composer = main?.querySelector<HTMLElement>(".composer");
    if (!summary || !main || !header || !composer) return;
    const update = () => {
      // Budget both rosters together, leaving an equal share for the terminal.
      // Derive the composer limit from its height, not a displaced position.
      const rosters = header.querySelectorAll<HTMLElement>(".subagent-roster");
      const rosterHeight = [
        ...header.querySelectorAll<HTMLElement>(".subagent-live-rail[open] > .subagent-roster"),
      ].reduce((height, roster) => height + roster.getBoundingClientRect().height, 0);
      const available =
        Math.min(window.innerHeight, main.getBoundingClientRect().bottom) -
        composer.getBoundingClientRect().height -
        (header.getBoundingClientRect().bottom - rosterHeight);
      setMaxHeight(Math.max(0, Math.min(160, Math.floor(available / (rosters.length + 1)))));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(summary);
    observer.observe(main);
    observer.observe(header);
    observer.observe(composer);
    window.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [visible]);
  if (!visible) return null;
  const phases = ["running", "queued", "finishing"] as const;
  return (
    <details className="subagent-live-rail activity-rail-row" data-kind={kind}>
      <summary ref={summaryRef}>
        <span className="activity-rail-marker" aria-hidden="true" />
        <span className="activity-rail-summary">{kind === "shell" ? "shell" : "subagents"}</span>
        <span className="subagent-counts" aria-live="polite">
          {phases.map((phase) => {
            const count = roster.filter((agent) => agent.phase === phase).length;
            return count > 0 ? (
              <span key={phase} className={`subagent-phase-${phase}`}>
                {count} {phase}
              </span>
            ) : null;
          })}
        </span>
      </summary>
      <ul className="subagent-roster" style={{ maxHeight }}>
        {roster.map((agent) => (
          <SubagentRow key={agent.id} agent={agent} context={context} />
        ))}
      </ul>
    </details>
  );
}

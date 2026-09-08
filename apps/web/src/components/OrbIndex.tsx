import type { OrbView } from "@pi-orb/protocol";
import { useEffect, useState } from "react";
import { getProject, listOrbs } from "../lib/api.ts";
import { FAVICON_HREFS } from "../lib/favicon.ts";
import { formatProjectOrbAge, projectOrbGlyph, splitProjectOrbs } from "../lib/project-orbs.ts";
import { StateTile } from "./StateTile.tsx";

/** Project-scoped chrome survives conversation switches, including its scroll position. */
export function OrbIndex({
  projectId,
  orbId,
  pending,
}: {
  projectId: string | null;
  orbId: string;
  pending: boolean;
}) {
  const [projectName, setProjectName] = useState<string | null>(null);
  const [orbs, setOrbs] = useState<OrbView[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setProjectName(null);
    setOrbs(null);
    if (projectId === null) return;
    let cancelled = false;
    let inFlight = false;
    void getProject(projectId).then((result) => {
      if (!cancelled && result.isOk()) setProjectName(result.value.name);
    });
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      const result = await listOrbs(projectId);
      inFlight = false;
      if (!cancelled && result.isOk()) setOrbs(result.value.items);
    };
    void poll();
    const timer = window.setInterval(poll, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [projectId]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <nav className="orb-index" aria-label="Project orbs" aria-busy={pending}>
      <a className="ix-brand up" href="#/">
        <img src={FAVICON_HREFS.neutral} width={16} height={16} alt="" />
        pi-orb
      </a>
      <div className="sect">
        <span className="trunc">{projectName ?? "project"}</span>
      </div>
      {orbs !== null &&
        splitProjectOrbs(orbs).working.map((entry) => {
          const glyph = projectOrbGlyph(entry.state, entry.activity);
          const current = entry.id === orbId;
          return (
            <a
              className={`ix-row ix-row-${glyph.state}${current ? " ix-row-current" : ""}`}
              href={`#/orbs/${entry.id}`}
              key={entry.id}
              {...(current ? { "aria-current": "page" as const } : {})}
            >
              <StateTile glyph={glyph} />
              <span className="trunc">{entry.name ?? "untitled orb"}</span>
              <span className="ix-age">
                {current && pending ? "…" : formatProjectOrbAge(entry.updatedAt, now)}
              </span>
            </a>
          );
        })}
      {projectId !== null && (
        <div className="sect">
          <a className="text-action" href={`#/projects/${projectId}/orbs/new`}>
            new orb
          </a>
        </div>
      )}
    </nav>
  );
}

import type { OrbState, OrbView, ProjectView } from "@pi-orb/protocol";

export type ProjectOrbShelf = "working" | "archive";

const AGE_UNITS = [
  { unit: "y", milliseconds: 365 * 24 * 60 * 60 * 1_000 },
  { unit: "mo", milliseconds: 30 * 24 * 60 * 60 * 1_000 },
  { unit: "w", milliseconds: 7 * 24 * 60 * 60 * 1_000 },
  { unit: "d", milliseconds: 24 * 60 * 60 * 1_000 },
  { unit: "h", milliseconds: 60 * 60 * 1_000 },
  { unit: "m", milliseconds: 60 * 1_000 },
  { unit: "s", milliseconds: 1_000 },
] as const;

/** One whole number and the largest useful unit suffix. */
function formatCompactDuration(elapsed: number): string | null {
  const selected = AGE_UNITS.find(({ milliseconds }) => elapsed >= milliseconds);
  const unit = selected ?? AGE_UNITS.at(-1);
  if (unit === undefined) return null;

  return `${Math.max(1, Math.floor(elapsed / unit.milliseconds))}${unit.unit}`;
}

/** Compact update age. */
export function formatProjectOrbAge(updatedAt: string, now: number): string | null {
  const updated = Date.parse(updatedAt);
  if (!Number.isFinite(updated)) return null;

  return formatCompactDuration(Math.max(0, now - updated));
}

/** Compact time left, or null once the deadline has passed. */
export function formatTimeRemaining(deadline: string, now: number): string | null {
  const parsed = Date.parse(deadline);
  if (!Number.isFinite(parsed) || parsed <= now) return null;

  return formatCompactDuration(parsed - now);
}

export type OrbGlyphState = "busy" | "idle" | "start" | "stop" | "fail" | "arch" | "archng" | "del";

export interface OrbGlyph {
  /** Selects the hue for the glyph and the entry's left border. */
  state: OrbGlyphState;
  char: string;
  /** The state word, carried only as the glyph's title. */
  label: string;
}

const GLYPHS: Record<OrbGlyphState, string> = {
  busy: "\u25cf",
  idle: "\u25cb",
  start: "\u25d0",
  stop: "\u2013",
  fail: "\u2715",
  arch: "\u25ab",
  archng: "\u25d1",
  del: "\u2026",
};

/** The text state glyph: lifecycle state, refined by the latest activity observation. */
export function projectOrbGlyph(state: OrbState, activity?: OrbView["activity"]): OrbGlyph {
  const busy = state === "running" && activity === "busy";
  const glyphState: OrbGlyphState = busy
    ? "busy"
    : state === "running"
      ? "idle"
      : state === "stopped"
        ? "stop"
        : state === "failed"
          ? "fail"
          : state === "archived"
            ? "arch"
            : state === "archiving"
              ? "archng"
              : state === "deleting"
                ? "del"
                : "start";
  return { state: glyphState, char: GLYPHS[glyphState], label: busy ? "busy" : state };
}

/** Disposal and retained transcripts leave the working set for the archive shelf. */
export function projectOrbShelf(state: OrbState): ProjectOrbShelf {
  return state === "archiving" || state === "archived" || state === "deleting"
    ? "archive"
    : "working";
}

export function splitProjectOrbs(items: OrbView[]): {
  working: OrbView[];
  archive: OrbView[];
} {
  const sortableTime = (value: string) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
  };
  const latestFirst = (left: OrbView, right: OrbView) => {
    const leftUpdated = sortableTime(left.updatedAt);
    const rightUpdated = sortableTime(right.updatedAt);
    if (leftUpdated !== rightUpdated) return rightUpdated > leftUpdated ? 1 : -1;

    const leftCreated = sortableTime(left.createdAt);
    const rightCreated = sortableTime(right.createdAt);
    if (leftCreated === rightCreated) return 0;
    return rightCreated > leftCreated ? 1 : -1;
  };

  return {
    working: items.filter((orb) => projectOrbShelf(orb.state) === "working").sort(latestFirst),
    archive: items.filter((orb) => projectOrbShelf(orb.state) === "archive").sort(latestFirst),
  };
}

export interface DashboardTotals {
  projects: number;
  orbs: number;
  busy: number;
  failed: number;
}

/**
 * The four counts on the dashboard's totals strip, taken from whatever has
 * loaded: every project including one being deleted, and the working-set orbs
 * of the projects whose lists have arrived. A project whose orbs are still in
 * flight simply contributes nothing yet, which is why the strip needs no
 * placeholder.
 */
export function dashboardTotals(
  projects: readonly ProjectView[],
  orbsByProject: Readonly<Record<string, readonly OrbView[] | undefined>>,
): DashboardTotals {
  const working = Object.values(orbsByProject)
    .flatMap((orbs) => [...(orbs ?? [])])
    .filter((orb) => projectOrbShelf(orb.state) === "working");
  return {
    projects: projects.length,
    orbs: working.length,
    busy: working.filter((orb) => orb.state === "running" && orb.activity === "busy").length,
    failed: working.filter((orb) => orb.state === "failed").length,
  };
}

export function projectOrbActions(state: OrbState): {
  archive: boolean;
  delete: boolean;
} {
  return {
    archive: projectOrbShelf(state) === "working",
    delete: state !== "deleting",
  };
}

/**
 * Dashboard column order: the project whose working set moved most recently
 * comes first, projects with no working orbs follow, and a deleting project
 * sinks to the end. Equal projects keep their incoming order.
 */
export function orderProjects(
  projects: readonly ProjectView[],
  orbsByProject: Readonly<Record<string, readonly OrbView[] | undefined>>,
): ProjectView[] {
  const latestWorkingUpdate = (project: ProjectView): number | null => {
    const times = (orbsByProject[project.id] ?? [])
      .filter((orb) => projectOrbShelf(orb.state) === "working")
      .map((orb) => Date.parse(orb.updatedAt))
      .filter((time) => Number.isFinite(time));
    return times.length === 0 ? null : Math.max(...times);
  };

  return projects
    .map((project, index) => ({ project, index, latest: latestWorkingUpdate(project) }))
    .sort((left, right) => {
      const rank = (entry: typeof left) =>
        entry.project.state === "deleting" ? 2 : entry.latest === null ? 1 : 0;
      if (rank(left) !== rank(right)) return rank(left) - rank(right);
      if (left.latest !== right.latest && left.latest !== null && right.latest !== null) {
        return right.latest - left.latest;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.project);
}

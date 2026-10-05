import type { OrbState, OrbView, ProjectView } from "@pi-orb/protocol";
import { FAVICON_HREFS, isOrbSleeping } from "./favicon.ts";

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

export type OrbGlyphState =
  | "busy"
  | "idle"
  | "start"
  | "stop"
  | "sleep"
  | "fail"
  | "arch"
  | "archng"
  | "del"
  | "alert";

export interface OrbGlyph {
  /** Selects the hue for the glyph and the entry's left border. */
  state: OrbGlyphState;
  iconHref: string;
  /** The state word, carried only as the glyph's title. */
  label: string;
}

const GLYPHS: Record<OrbGlyphState, string> = {
  busy: FAVICON_HREFS.busy,
  idle: FAVICON_HREFS.running,
  start: FAVICON_HREFS.transitional,
  stop: FAVICON_HREFS.stopped,
  sleep: FAVICON_HREFS.sleeping,
  fail: FAVICON_HREFS.failed,
  arch: FAVICON_HREFS.archived,
  archng: FAVICON_HREFS.archiving,
  del: FAVICON_HREFS.deleting,
  alert: FAVICON_HREFS.alert,
};

/** Shared favicon/UI tile, refined by the latest activity observation. */
export function projectOrbGlyph(
  state: OrbState,
  activity?: OrbView["activity"],
  sleepUntil?: OrbView["sleepUntil"],
  unreadAlertId?: string | null,
): OrbGlyph {
  if (unreadAlertId) return { state: "alert", iconHref: GLYPHS.alert, label: "Unread alert" };
  const busy = state === "running" && activity === "busy";
  const sleeping = isOrbSleeping(state, sleepUntil);
  const glyphState: OrbGlyphState = busy
    ? "busy"
    : state === "running"
      ? "idle"
      : sleeping
        ? "sleep"
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
  return {
    state: glyphState,
    iconHref: GLYPHS[glyphState],
    label: sleeping ? "Orb sleeping" : busy ? "busy" : state,
  };
}

/** Disposal and retained transcripts leave the working set for the archive shelf. */
export function projectOrbShelf(state: OrbState): ProjectOrbShelf {
  return state === "archiving" || state === "archived" || state === "deleting"
    ? "archive"
    : "working";
}

export type OrbOrderCache = Map<string, { updated: number; created: number; position: number }>;

/** Keep one cache per mounted fleet view, including keys for temporarily absent orbs. */
export function splitProjectOrbs(
  items: OrbView[],
  order: OrbOrderCache = new Map(),
): {
  working: OrbView[];
  archive: OrbView[];
} {
  const sortableTime = (value: string) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
  };
  const ordered = items
    .map((orb) => {
      let key = order.get(orb.id);
      if (key === undefined) {
        key = {
          updated: sortableTime(orb.updatedAt),
          created: sortableTime(orb.createdAt),
          position: order.size,
        };
        order.set(orb.id, key);
      }
      return { orb, key };
    })
    .sort((left, right) => {
      if (left.key.updated !== right.key.updated)
        return right.key.updated > left.key.updated ? 1 : -1;
      if (left.key.created !== right.key.created)
        return right.key.created > left.key.created ? 1 : -1;
      return left.key.position - right.key.position;
    })
    .map(({ orb }) => orb);

  return {
    working: ordered.filter((orb) => projectOrbShelf(orb.state) === "working"),
    archive: ordered.filter((orb) => projectOrbShelf(orb.state) === "archive"),
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

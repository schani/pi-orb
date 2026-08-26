import type { OrbState, OrbView } from "@pi-orb/protocol";
import type { OrbFaviconStatus } from "./favicon.ts";

export type ProjectOrbShelf = "working" | "archive";

const AGE_UNITS = [
  { unit: "year", milliseconds: 365 * 24 * 60 * 60 * 1_000 },
  { unit: "month", milliseconds: 30 * 24 * 60 * 60 * 1_000 },
  { unit: "week", milliseconds: 7 * 24 * 60 * 60 * 1_000 },
  { unit: "day", milliseconds: 24 * 60 * 60 * 1_000 },
  { unit: "hour", milliseconds: 60 * 60 * 1_000 },
  { unit: "minute", milliseconds: 60 * 1_000 },
] as const;

/** Compact dashboard update age: one whole number and the largest useful unit. */
export function formatProjectOrbAge(updatedAt: string, now: number): string | null {
  const updated = Date.parse(updatedAt);
  if (!Number.isFinite(updated)) return null;

  const elapsed = Math.max(0, now - updated);
  const selected = AGE_UNITS.find(({ milliseconds }) => elapsed >= milliseconds);
  const unit = selected ?? AGE_UNITS.at(-1);
  if (unit === undefined) return null;

  const count = Math.max(1, Math.floor(elapsed / unit.milliseconds));
  return `${count} ${unit.unit}${count === 1 ? "" : "s"}`;
}

/** Project rows add the latest API activity observation to the lifecycle glyph mapping. */
export function projectOrbFaviconStatus(
  state: OrbState,
  activity?: OrbView["activity"],
): OrbFaviconStatus {
  if (state === "running") return activity === "busy" ? "busy" : "running";
  if (state === "stopped" || state === "archived") return "stopped";
  if (state === "failed") return "failed";
  return "transitional";
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

export function projectOrbActions(state: OrbState): {
  archive: boolean;
  delete: boolean;
} {
  return {
    archive: projectOrbShelf(state) === "working",
    delete: state !== "deleting",
  };
}

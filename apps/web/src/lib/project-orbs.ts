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

/** Compact dashboard age: one whole number and the largest useful unit. */
export function formatProjectOrbAge(createdAt: string, now: number): string | null {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return null;

  const elapsed = Math.max(0, now - created);
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
  return {
    working: items.filter((orb) => projectOrbShelf(orb.state) === "working"),
    archive: items.filter((orb) => projectOrbShelf(orb.state) === "archive"),
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

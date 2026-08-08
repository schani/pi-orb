import type { OrbState, OrbView } from "@pi-orb/protocol";
import type { OrbFaviconStatus } from "./favicon.ts";

export type ProjectOrbShelf = "working" | "archive";

/** Project rows use the same coarse glyph mapping as the browser-tab favicon. */
export function projectOrbFaviconStatus(state: OrbState): OrbFaviconStatus {
  if (state === "running") return "running";
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

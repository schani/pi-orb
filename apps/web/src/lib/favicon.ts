import type { OrbState } from "@pi-orb/protocol";
import type { LiveConnectionStatus } from "./live.ts";

export type OrbFaviconStatus =
  | "neutral"
  | "stopped"
  | "running"
  | "busy"
  | "transitional"
  | "failed";

const FAVICON_HREFS: Record<OrbFaviconStatus, string> = {
  neutral: "/favicons/neutral.svg",
  stopped: "/favicons/stopped.svg",
  running: "/favicons/running.svg",
  busy: "/favicons/busy.svg",
  transitional: "/favicons/transitional.svg",
  failed: "/favicons/failed.svg",
};

/** Derives tab status from durable lifecycle state plus current live activity. */
export function deriveOrbFaviconStatus(
  orbState: OrbState | null,
  connection: LiveConnectionStatus,
  activity: "idle" | "busy" | null,
): OrbFaviconStatus {
  if (orbState === null) return "neutral";
  if (orbState === "failed") return "failed";
  if (orbState === "stopped" || orbState === "archived") return "stopped";
  if (
    orbState === "creating" ||
    orbState === "starting" ||
    orbState === "stopping" ||
    orbState === "deleting" ||
    orbState === "archiving"
  ) {
    return "transitional";
  }
  return connection === "open" && activity === "busy" ? "busy" : "running";
}

interface FaviconDocument {
  getElementById(id: string): { setAttribute(name: string, value: string): void } | null;
}

/** Updates the single static favicon link installed by index.html. */
export function setOrbFavicon(status: OrbFaviconStatus, target: FaviconDocument = document): void {
  target.getElementById("pi-orb-favicon")?.setAttribute("href", FAVICON_HREFS[status]);
}

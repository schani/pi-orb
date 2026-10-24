import type { OrbView, ProjectView } from "@pi-orb/protocol";
import type { ApiError } from "./api.ts";
import type { OrbOrderCache, ProjectOrderCache } from "./project-orbs.ts";

export type DashboardOrbList =
  | { type: "loading" }
  | { type: "loaded"; items: OrbView[] }
  | { type: "failed"; error: ApiError; items: OrbView[] };

interface DashboardSnapshot {
  projects: ProjectView[] | null;
  loadError: ApiError | null;
  orbLists: Record<string, DashboardOrbList | undefined>;
}

/** Default fleet only; owned by the authenticated application, never persisted. */
export class DashboardCache {
  private snapshot: DashboardSnapshot = { projects: null, loadError: null, orbLists: {} };
  private listeners = new Set<() => void>();
  readonly orbOrder: OrbOrderCache = new Map();
  readonly projectOrder: ProjectOrderCache = new Map();
  revision = 0;

  getSnapshot = (): DashboardSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  update(change: (previous: DashboardSnapshot) => DashboardSnapshot): void {
    this.snapshot = change(this.snapshot);
    for (const listener of this.listeners) listener();
  }

  upsertOrb(orb: OrbView): void {
    this.revision += 1;
    if (!this.snapshot.projects?.some((project) => project.id === orb.projectId)) return;
    this.update((previous) => {
      const list = previous.orbLists[orb.projectId];
      const items = list?.type === "loading" ? [] : (list?.items ?? []);
      const found = items.some((item) => item.id === orb.id);
      return {
        ...previous,
        orbLists: {
          ...previous.orbLists,
          [orb.projectId]: {
            ...(list?.type === "failed" ? list : { type: "loaded" as const }),
            items: found
              ? items.map((item) =>
                  item.id === orb.id
                    ? {
                        ...orb,
                        ...(orb.spawnedByOrb === undefined && item.spawnedByOrb !== undefined
                          ? { spawnedByOrb: item.spawnedByOrb }
                          : {}),
                      }
                    : item,
                )
              : [...items, orb],
          },
        },
      };
    });
  }
}

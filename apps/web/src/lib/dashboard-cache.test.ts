import type { OrbView, ProjectView } from "@pi-orb/protocol";
import { expect, it } from "vitest";
import { DashboardCache } from "./dashboard-cache.ts";

const project: ProjectView = {
  id: "p",
  name: "Project",
  repositoryUrl: null,
  state: "active",
  createdAt: "now",
  updatedAt: "now",
};
const orb: OrbView = {
  id: "o",
  projectId: "p",
  name: "Orb",
  harness: "pi",
  state: "stopped",
  stateVersion: 1,
  createdAt: "now",
  updatedAt: "now",
  stateChangedAt: "now",
};
it("owns independent snapshots and publishes changes to subscribers", () => {
  const cache = new DashboardCache();
  const other = new DashboardCache();
  let updates = 0;
  const unsubscribe = cache.subscribe(() => {
    updates += 1;
  });
  cache.update((previous) => ({ ...previous, projects: [project] }));
  expect(cache.getSnapshot().projects).toEqual([project]);
  expect(other.getSnapshot().projects).toBeNull();
  expect(other.orbOrder).not.toBe(cache.orbOrder);
  expect(updates).toBe(1);
  unsubscribe();
  cache.upsertOrb(orb);
  expect(updates).toBe(1);
});
it("upserts mutations only for known default projects, retaining metadata omitted from mutation DTOs", () => {
  const cache = new DashboardCache();
  cache.upsertOrb(orb);
  expect(cache.getSnapshot().orbLists).toEqual({});
  cache.update((previous) => ({
    ...previous,
    projects: [project],
    orbLists: {
      p: {
        type: "loaded",
        items: [
          {
            ...orb,
            spawnedByOrb: "parent",
            sleepUntil: "later",
            lastError: "old",
            unreadAlertId: "old-alert",
          },
        ],
      },
    },
  }));
  const revision = cache.revision;
  cache.upsertOrb({ ...orb, name: "Renamed", state: "archiving" });
  expect(cache.revision).toBeGreaterThan(revision);
  expect(cache.getSnapshot().orbLists["p"]).toMatchObject({
    type: "loaded",
    items: [{ name: "Renamed", state: "archiving", spawnedByOrb: "parent" }],
  });
  const list = cache.getSnapshot().orbLists["p"];
  expect(list?.type === "loading" ? null : list?.items[0]?.sleepUntil).toBeUndefined();
  expect(list?.type === "loading" ? null : list?.items[0]?.lastError).toBeUndefined();
  expect(list?.type === "loading" ? null : list?.items[0]?.unreadAlertId).toBeUndefined();
  cache.upsertOrb({ ...orb, projectId: "addressed-only" });
  expect(cache.getSnapshot().projects).toEqual([project]);
  expect(cache.getSnapshot().orbLists["addressed-only"]).toBeUndefined();
});

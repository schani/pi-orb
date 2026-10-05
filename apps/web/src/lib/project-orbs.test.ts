import type { OrbState, OrbView, ProjectView } from "@pi-orb/protocol";
import { describe, expect, it } from "vitest";
import {
  dashboardTotals,
  formatProjectOrbAge,
  orderProjects,
  projectOrbActions,
  projectOrbGlyph,
  projectOrbShelf,
  splitProjectOrbs,
} from "./project-orbs.ts";

const project = (id: string, state: ProjectView["state"] = "active"): ProjectView => ({
  id,
  name: id,
  repositoryUrl: `https://github.com/acme/${id}`,
  state,
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
});

const orb = (id: string, state: OrbState, updatedAt = "2026-08-09T00:00:00.000Z"): OrbView => ({
  id,
  projectId: "project",
  name: id,
  state,
  stateVersion: 1,
  stateChangedAt: "2026-08-09T00:00:00.000Z",
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt,
});

describe("project orb presentation", () => {
  it("formats update age as one number and the largest useful unit suffix", () => {
    const now = Date.parse("2026-08-26T12:00:00.000Z");
    const before = (milliseconds: number) => new Date(now - milliseconds).toISOString();

    expect(formatProjectOrbAge(before(12_000), now)).toBe("12s");
    expect(formatProjectOrbAge(before(14 * 60_000), now)).toBe("14m");
    expect(formatProjectOrbAge(before(3 * 60 * 60_000), now)).toBe("3h");
    expect(formatProjectOrbAge(before(3 * 24 * 60 * 60_000), now)).toBe("3d");
    expect(formatProjectOrbAge(before(21 * 24 * 60 * 60_000), now)).toBe("3w");
    expect(formatProjectOrbAge(before(35 * 24 * 60 * 60_000), now)).toBe("1mo");
    expect(formatProjectOrbAge(before(365 * 24 * 60 * 60_000), now)).toBe("1y");
    expect(formatProjectOrbAge(new Date(now).toISOString(), now)).toBe("1s");
    expect(formatProjectOrbAge("not-a-date", now)).toBeNull();
  });

  it("moves disposal states to the archive shelf and sorts each shelf by latest update", () => {
    expect(projectOrbShelf("running")).toBe("working");
    expect(projectOrbShelf("archiving")).toBe("archive");
    expect(projectOrbShelf("archived")).toBe("archive");
    expect(projectOrbShelf("deleting")).toBe("archive");

    const older = "2026-08-09T01:00:00.000Z";
    const newer = "2026-08-09T02:00:00.000Z";
    expect(
      splitProjectOrbs([
        orb("older-active", "running", older),
        orb("newer-archived", "archived", newer),
        orb("older-archived", "archived", older),
        orb("newer-active", "stopped", newer),
      ]),
    ).toEqual({
      working: [orb("newer-active", "stopped", newer), orb("older-active", "running", older)],
      archive: [orb("newer-archived", "archived", newer), orb("older-archived", "archived", older)],
    });
  });

  it("names each lifecycle state with one glyph and its hue", () => {
    expect(projectOrbGlyph("running", "busy")).toEqual({
      state: "busy",
      iconHref: "/favicons/busy.svg",
      label: "busy",
    });
    expect(projectOrbGlyph("running")).toEqual({
      state: "idle",
      iconHref: "/favicons/running.svg",
      label: "running",
    });
    expect(projectOrbGlyph("starting").state).toBe("start");
    expect(projectOrbGlyph("creating").state).toBe("start");
    expect(projectOrbGlyph("stopping").state).toBe("start");
    expect(projectOrbGlyph("stopped")).toEqual({
      state: "stop",
      iconHref: "/favicons/stopped.svg",
      label: "stopped",
    });
    expect(projectOrbGlyph("failed")).toEqual({
      state: "fail",
      iconHref: "/favicons/failed.svg",
      label: "failed",
    });
    expect(projectOrbGlyph("archived").state).toBe("arch");
    expect(projectOrbGlyph("archiving").state).toBe("archng");
    expect(projectOrbGlyph("deleting")).toEqual({
      state: "del",
      iconHref: "/favicons/deleting.svg",
      label: "deleting",
    });
  });

  it("overrides every state with the shared alert flag and restores the current state", () => {
    for (const state of [
      "running",
      "creating",
      "starting",
      "stopping",
      "stopped",
      "failed",
      "archiving",
      "archived",
      "deleting",
    ] as const) {
      const activity = state === "running" ? "busy" : undefined;
      expect(projectOrbGlyph(state, activity, undefined, "alert-id")).toEqual({
        state: "alert",
        iconHref: "/favicons/alert.svg",
        label: "Unread alert",
      });
      expect(projectOrbGlyph(state, activity, undefined, null).state).not.toBe("alert");
    }
    expect(projectOrbGlyph("stopped", undefined, "tomorrow", "alert-id").state).toBe("alert");
    expect(projectOrbGlyph("stopped", undefined, "tomorrow", null).state).toBe("sleep");
  });

  it("uses sleeping only for stopped orbs with a deadline", () => {
    const sleepUntil = "2026-09-18T00:00:00.000Z";
    expect(projectOrbGlyph("stopped", undefined, sleepUntil)).toEqual({
      state: "sleep",
      iconHref: "/favicons/sleeping.svg",
      label: "Orb sleeping",
    });
    expect(projectOrbGlyph("stopped", undefined, undefined).iconHref).toBe("/favicons/stopped.svg");
    for (const state of [
      "running",
      "creating",
      "starting",
      "stopping",
      "failed",
      "archiving",
      "archived",
      "deleting",
    ] as const) {
      expect(
        projectOrbGlyph(state, state === "running" ? "busy" : undefined, sleepUntil).iconHref,
      ).not.toBe("/favicons/sleeping.svg");
    }
  });

  it("exposes only actions accepted by the lifecycle state", () => {
    expect(projectOrbActions("running")).toEqual({ archive: true, delete: true });
    expect(projectOrbActions("archiving")).toEqual({ archive: false, delete: true });
    expect(projectOrbActions("archived")).toEqual({ archive: false, delete: true });
    expect(projectOrbActions("deleting")).toEqual({ archive: false, delete: false });
  });
});

describe("first-appearance orb ordering", () => {
  const old = "2026-08-09T01:00:00.000Z";
  const recent = "2026-08-09T02:00:00.000Z";
  const latest = "2026-08-09T03:00:00.000Z";

  it("freezes sort timestamps but returns fresh metadata and inserts newcomers by their timestamp", () => {
    const order = new Map();
    const initial: [OrbView, OrbView] = [
      orb("old", "running", old),
      orb("recent", "stopped", recent),
    ];
    expect(splitProjectOrbs(initial, order).working.map((item) => item.id)).toEqual([
      "recent",
      "old",
    ]);
    const refreshed = {
      ...initial[0],
      name: "Renamed",
      activity: "busy" as const,
      updatedAt: latest,
    };
    const newcomer = orb("new", "running", "2026-08-09T01:30:00.000Z");
    const result = splitProjectOrbs([refreshed, newcomer, initial[1]], order);
    expect(result.working.map((item) => item.id)).toEqual(["recent", "new", "old"]);
    expect(result.working[2]).toBe(refreshed);
    expect(initial.map((item) => item.id)).toEqual(["old", "recent"]);
    expect(splitProjectOrbs([refreshed, initial[1]], new Map()).working[0]).toBe(refreshed);
  });

  it("retains keys through absence and lifecycle shelf changes", () => {
    const order = new Map();
    splitProjectOrbs([orb("old", "running", old), orb("recent", "archived", recent)], order);
    splitProjectOrbs([], order);
    const result = splitProjectOrbs(
      [orb("old", "archiving", latest), orb("recent", "archived", recent)],
      order,
    );
    expect(result.archive.map((item) => item.id)).toEqual(["recent", "old"]);
    expect(result.working).toEqual([]);
  });

  it("breaks equal update times by first-seen creation time, then first-appearance position", () => {
    const order = new Map();
    const first = orb("first", "running", recent);
    const second = orb("second", "running", recent);
    const newerCreation = { ...orb("created-later", "running", recent), createdAt: recent };
    expect(
      splitProjectOrbs([first, second, newerCreation], order).working.map((item) => item.id),
    ).toEqual(["created-later", "first", "second"]);
    expect(
      splitProjectOrbs([second, first, newerCreation], order).working.map((item) => item.id),
    ).toEqual(["created-later", "first", "second"]);
    const result = splitProjectOrbs(
      [second, { ...first, createdAt: latest }, newerCreation, orb("new-tie", "running", recent)],
      order,
    );
    expect(result.working.map((item) => item.id)).toEqual([
      "created-later",
      "first",
      "second",
      "new-tie",
    ]);
  });

  it("keeps invalid first-seen timestamps last even if later corrected", () => {
    const order = new Map();
    splitProjectOrbs([orb("invalid", "running", "invalid"), orb("valid", "running", old)], order);
    expect(
      splitProjectOrbs(
        [orb("invalid", "running", latest), orb("valid", "running", old)],
        order,
      ).working.map((item) => item.id),
    ).toEqual(["valid", "invalid"]);
  });
});

describe("dashboard project order", () => {
  const old = "2026-08-09T01:00:00.000Z";
  const recent = "2026-08-09T05:00:00.000Z";

  it("puts the most recently worked project first and a deleting project last", () => {
    const ordered = orderProjects(
      [project("quiet"), project("stale"), project("going", "deleting"), project("hot")],
      {
        quiet: [orb("archived-only", "archived", recent)],
        stale: [orb("stale-orb", "stopped", old)],
        going: [orb("doomed", "running", recent)],
        hot: [orb("hot-orb", "running", recent)],
      },
    );

    expect(ordered.map((entry) => entry.id)).toEqual(["hot", "stale", "quiet", "going"]);
  });

  it("keeps incoming order for projects the working set cannot separate", () => {
    const ordered = orderProjects([project("a"), project("b"), project("c")], {
      a: [orb("a-orb", "running", recent)],
      b: [orb("b-orb", "running", recent)],
      c: [],
    });

    expect(ordered.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });

  it("treats a project whose orbs have not loaded as having no working set", () => {
    const ordered = orderProjects([project("unknown"), project("known")], {
      known: [orb("known-orb", "running", old)],
    });

    expect(ordered.map((entry) => entry.id)).toEqual(["known", "unknown"]);
  });
});

describe("dashboard totals", () => {
  const busy = (id: string): OrbView => ({ ...orb(id, "running"), activity: "busy" });

  it("counts every project and only the working-set orbs that have loaded", () => {
    const totals = dashboardTotals(
      [project("acme"), project("pi-orb"), project("legacy", "deleting")],
      {
        acme: [busy("hot"), orb("idle", "running"), orb("broken", "failed")],
        "pi-orb": [orb("shelved", "archived"), orb("going", "deleting")],
      },
    );

    expect(totals).toEqual({ projects: 3, orbs: 3, busy: 1, failed: 1 });
  });

  it("counts nothing for a project whose orbs are still loading", () => {
    expect(dashboardTotals([project("acme")], {})).toEqual({
      projects: 1,
      orbs: 0,
      busy: 0,
      failed: 0,
    });
  });

  it("does not count a running orb whose activity is unknown as busy", () => {
    expect(dashboardTotals([project("acme")], { acme: [orb("unknown", "running")] })).toEqual({
      projects: 1,
      orbs: 1,
      busy: 0,
      failed: 0,
    });
  });
});

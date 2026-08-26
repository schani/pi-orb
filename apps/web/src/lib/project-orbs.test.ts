import type { OrbState, OrbView } from "@pi-orb/protocol";
import { describe, expect, it } from "vitest";
import {
  formatProjectOrbAge,
  projectOrbActions,
  projectOrbFaviconStatus,
  projectOrbShelf,
  splitProjectOrbs,
} from "./project-orbs.ts";

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
  it("formats update age as one number and the largest useful unit", () => {
    const now = Date.parse("2026-08-26T12:00:00.000Z");
    const before = (milliseconds: number) => new Date(now - milliseconds).toISOString();

    expect(formatProjectOrbAge(before(14 * 60_000), now)).toBe("14 minutes");
    expect(formatProjectOrbAge(before(3 * 24 * 60 * 60_000), now)).toBe("3 days");
    expect(formatProjectOrbAge(before(35 * 24 * 60 * 60_000), now)).toBe("1 month");
    expect(formatProjectOrbAge(before(365 * 24 * 60 * 60_000), now)).toBe("1 year");
    expect(formatProjectOrbAge(new Date(now).toISOString(), now)).toBe("1 minute");
    expect(formatProjectOrbAge("not-a-date", now)).toBeNull();
  });

  it("uses current activity for running orbs and lifecycle state otherwise", () => {
    expect(projectOrbFaviconStatus("running", "busy")).toBe("busy");
    expect(projectOrbFaviconStatus("running", "idle")).toBe("running");
    expect(projectOrbFaviconStatus("running")).toBe("running");
    expect(projectOrbFaviconStatus("stopped", "busy")).toBe("stopped");
    expect(projectOrbFaviconStatus("archived")).toBe("stopped");
    expect(projectOrbFaviconStatus("failed")).toBe("failed");
    expect(projectOrbFaviconStatus("archiving")).toBe("transitional");
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

  it("exposes only actions accepted by the lifecycle state", () => {
    expect(projectOrbActions("running")).toEqual({ archive: true, delete: true });
    expect(projectOrbActions("archiving")).toEqual({ archive: false, delete: true });
    expect(projectOrbActions("archived")).toEqual({ archive: false, delete: true });
    expect(projectOrbActions("deleting")).toEqual({ archive: false, delete: false });
  });
});

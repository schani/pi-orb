import type { OrbState, OrbView } from "@pi-orb/protocol";
import { describe, expect, it } from "vitest";
import {
  projectOrbActions,
  projectOrbFaviconStatus,
  projectOrbShelf,
  splitProjectOrbs,
} from "./project-orbs.ts";

const orb = (id: string, state: OrbState): OrbView => ({
  id,
  projectId: "project",
  name: id,
  state,
  stateVersion: 1,
  stateChangedAt: "2026-08-09T00:00:00.000Z",
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
});

describe("project orb presentation", () => {
  it("uses current activity for running orbs and lifecycle state otherwise", () => {
    expect(projectOrbFaviconStatus("running", "busy")).toBe("busy");
    expect(projectOrbFaviconStatus("running", "idle")).toBe("running");
    expect(projectOrbFaviconStatus("running")).toBe("running");
    expect(projectOrbFaviconStatus("stopped", "busy")).toBe("stopped");
    expect(projectOrbFaviconStatus("archived")).toBe("stopped");
    expect(projectOrbFaviconStatus("failed")).toBe("failed");
    expect(projectOrbFaviconStatus("archiving")).toBe("transitional");
  });

  it("moves disposal states and retained transcripts to the archive shelf", () => {
    expect(projectOrbShelf("running")).toBe("working");
    expect(projectOrbShelf("archiving")).toBe("archive");
    expect(projectOrbShelf("archived")).toBe("archive");
    expect(projectOrbShelf("deleting")).toBe("archive");
    expect(splitProjectOrbs([orb("active", "running"), orb("past", "archived")])).toEqual({
      working: [orb("active", "running")],
      archive: [orb("past", "archived")],
    });
  });

  it("exposes only actions accepted by the lifecycle state", () => {
    expect(projectOrbActions("running")).toEqual({ archive: true, delete: true });
    expect(projectOrbActions("archiving")).toEqual({ archive: false, delete: true });
    expect(projectOrbActions("archived")).toEqual({ archive: false, delete: true });
    expect(projectOrbActions("deleting")).toEqual({ archive: false, delete: false });
  });
});

import type { OrbState, OrbView, ProjectView } from "@pi-orb/protocol";
import { describe, expect, it } from "vitest";
import { matchAppSearchItems } from "./app-search.ts";
import { buildDashboardSearchSource } from "./dashboard-search-source.ts";

const project = (id: string, name: string, repositoryUrl: string): ProjectView => ({
  id,
  name,
  repositoryUrl,
  state: "active",
  createdAt: "2026-08-26T00:00:00.000Z",
  updatedAt: "2026-08-26T00:00:00.000Z",
});

const orb = (id: string, name: string | null, state: OrbState): OrbView => ({
  id,
  projectId: "project-1",
  name,
  state,
  stateVersion: 1,
  stateChangedAt: "2026-08-26T00:00:00.000Z",
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-26T00:00:00.000Z",
});

const now = Date.parse("2026-08-26T00:14:00.000Z");

describe("dashboard search source", () => {
  it("maps projects and shelf-ordered orbs to canonical native links", () => {
    const source = buildDashboardSearchSource({
      projects: [project("project/1", "Atlas", "https://github.com/acme/atlas.git")],
      projectsLoading: false,
      projectsFailed: false,
      now,
      orbLists: {
        "project/1": {
          type: "loaded",
          items: [orb("archived/1", "Old plan", "archived"), orb("working/1", null, "running")],
        },
      },
    });

    expect(
      source.items.map(({ kindLabel, title, context, href }) => ({
        kindLabel,
        title,
        context,
        href,
      })),
    ).toEqual([
      {
        kindLabel: "project",
        title: "Atlas",
        context: "https://github.com/acme/atlas.git",
        href: "#/projects/project%2F1",
      },
      {
        kindLabel: "orb",
        title: "untitled orb",
        context: "Atlas · working set · 14 minutes",
        href: "#/orbs/working%2F1",
      },
      {
        kindLabel: "archived orb",
        title: "Old plan",
        context: "Atlas · archive shelf · 14 minutes",
        href: "#/orbs/archived%2F1",
      },
    ]);
    expect(matchAppSearchItems(source.items, "github.com/acme/atlas")[0]?.key).toBe(
      "dashboard:project:project/1",
    );
  });

  it("does not make ids or lifecycle state implicitly searchable", () => {
    const source = buildDashboardSearchSource({
      projects: [project("secret-project-id", "Atlas", "https://github.com/acme/atlas")],
      projectsLoading: false,
      projectsFailed: false,
      now,
      orbLists: {
        "secret-project-id": {
          type: "loaded",
          items: [orb("secret-orb-id", "Compiler repair", "archived")],
        },
      },
    });

    expect(matchAppSearchItems(source.items, "secret-project-id")).toEqual([]);
    expect(matchAppSearchItems(source.items, "secret-orb-id")).toEqual([]);
    expect(matchAppSearchItems(source.items, "archived")).toEqual([]);
  });

  it("reports partial and loading snapshots without hiding loaded items", () => {
    const projects = [
      project("loaded", "Loaded", "https://github.com/acme/loaded"),
      project("failed", "Failed list", "https://github.com/acme/failed"),
      project("loading", "Loading list", "https://github.com/acme/loading"),
    ];
    const source = buildDashboardSearchSource({
      projects,
      projectsLoading: false,
      projectsFailed: false,
      now,
      orbLists: {
        loaded: { type: "loaded", items: [orb("orb", "Visible orb", "running")] },
        failed: { type: "failed" },
        loading: { type: "loading" },
      },
    });

    expect(source.items.map(({ title }) => title)).toContain("Visible orb");
    expect(source.status).toEqual({
      type: "partial_error",
      message: "Some orbs could not be searched; other orbs are still loading",
    });
  });
});

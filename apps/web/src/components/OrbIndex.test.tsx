import type { OrbView, ProjectView } from "@pi-orb/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IndexProject, mergeIndexProjects } from "./OrbIndex.tsx";

const project: ProjectView = {
  id: "atlas",
  name: "Atlas",
  repositoryUrl: "https://github.com/example/atlas",
  state: "active",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
};
const orb: OrbView = {
  id: "orb-1",
  projectId: project.id,
  name: "Map tiles",
  state: "running",
  stateVersion: 1,
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
  stateChangedAt: project.createdAt,
};
const props = {
  project,
  orbId: orb.id,
  pending: false,
  now: Date.parse(project.createdAt),
  onChanged: () => {},
  onCreated: () => {},
};

describe("stacked project index", () => {
  it("preserves project positions while refreshing, removing, and appending", () => {
    const other = { ...project, id: "other", name: "Other" };
    const added = { ...project, id: "added", name: "Added" };
    expect(
      mergeIndexProjects([project, other], [added, other, { ...project, name: "Renamed" }]).map(
        (p) => p.name,
      ),
    ).toEqual(["Renamed", "Other", "Added"]);
    expect(mergeIndexProjects([project, other], [other])).toEqual([other]);
  });

  it("puts creation in the title, even for an empty project", () => {
    const html = renderToStaticMarkup(
      <IndexProject {...props} list={{ items: [], error: null }} />,
    );
    expect(html).toContain('href="#/projects/atlas/orbs/new"');
    expect(html).toContain('aria-label="New orb in Atlas"');
    expect(html).toContain('href="#i-plus"');
    expect(html).toContain('class="project-head-actions"');
    expect(html).not.toContain('class="project-new-orb-row"');
    expect(html).not.toContain("new orb</");
    expect(html).not.toContain("archive ·");
    expect(html).not.toContain("loading…");
  });

  it("keeps working, archived, and pending selections link-native", () => {
    const archived = { ...orb, id: "archive", state: "archived" as const };
    const html = renderToStaticMarkup(
      <IndexProject
        {...props}
        orbId="archive"
        pending
        list={{ items: [orb, archived], error: null }}
      />,
    );
    expect(html).toContain('href="#/orbs/orb-1"');
    expect(html).toContain('href="#/orbs/archive"');
    expect(html).toContain('class="project-archive" open=""');
    expect(html).toContain("ix-row-arch ix-row-current");
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toContain('class="ix-age">…</span>');
  });

  it("retains stale rows and reports partial load errors locally", () => {
    const error = { type: "network" as const, message: "offline" };
    const stale = renderToStaticMarkup(<IndexProject {...props} list={{ items: [orb], error }} />);
    expect(stale).toContain("Orb list is stale");
    expect(stale).toContain('role="alert"');
    expect(stale).toContain('href="#/orbs/orb-1"');
    const failed = renderToStaticMarkup(<IndexProject {...props} list={{ items: null, error }} />);
    expect(failed).toContain("Failed to load orbs");
    const loading = renderToStaticMarkup(<IndexProject {...props} list={undefined} />);
    expect(loading).toContain("loading…");
  });

  it("disables creation/config/delete and shows project deletion progress", () => {
    const html = renderToStaticMarkup(
      <IndexProject
        {...props}
        project={{ ...project, state: "deleting" }}
        list={{ items: [orb], error: null }}
      />,
    );
    expect(html.match(/disabled=""/g)).toHaveLength(3);
    expect(html).not.toContain('href="#/projects/atlas/orbs/new"');
    expect(html).not.toContain('href="#/orbs/orb-1"');
    expect(html).toContain("deleting project…");
  });
});

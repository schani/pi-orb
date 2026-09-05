import type { OrbView, ProjectView } from "@pi-orb/protocol";
import type { AppSearchItem, AppSearchSource } from "./app-search.ts";
import { formatProjectOrbAge, projectOrbGlyph, splitProjectOrbs } from "./project-orbs.ts";

export type DashboardOrbListSnapshot =
  | { type: "loading" }
  | { type: "loaded"; items: OrbView[] }
  | { type: "failed" };

export interface DashboardSearchSnapshot {
  projects: readonly ProjectView[];
  projectsLoading: boolean;
  projectsFailed: boolean;
  orbLists: Readonly<Record<string, DashboardOrbListSnapshot | undefined>>;
  now: number;
}

function githubRepositoryAlias(repositoryUrl: string): string | null {
  const withoutProtocol = repositoryUrl.replace(/^https?:\/\//i, "");
  if (!withoutProtocol.toLowerCase().startsWith("github.com/")) return null;
  return withoutProtocol
    .replace(/[?#].*$/, "")
    .replace(/\/$/, "")
    .replace(/\.git$/i, "");
}

function projectItem(project: ProjectView): AppSearchItem {
  const alias = githubRepositoryAlias(project.repositoryUrl);
  return {
    key: `dashboard:project:${project.id}`,
    kindLabel: "project",
    group: "projects",
    title: project.name,
    context: project.repositoryUrl,
    keywords:
      alias === null
        ? [project.name, project.repositoryUrl]
        : [project.name, project.repositoryUrl, alias],
    href: `#/projects/${encodeURIComponent(project.id)}`,
  };
}

function orbItem(
  project: ProjectView,
  orb: OrbView,
  archived: boolean,
  now: number,
): AppSearchItem {
  const name = orb.name ?? "untitled orb";
  const age = formatProjectOrbAge(orb.updatedAt, now);
  const glyph = projectOrbGlyph(orb.state, orb.activity);
  const context = [project.name, ...(archived ? ["archive"] : []), ...(age === null ? [] : [age])];
  return {
    key: `dashboard:orb:${orb.id}`,
    kindLabel: archived ? "archived orb" : "orb",
    group: "orbs",
    title: name,
    context: context.join(" · "),
    glyph: { char: glyph.char, state: glyph.state, label: glyph.label },
    chip: project.name,
    ...(age === null ? {} : { age }),
    keywords: [name],
    href: `#/orbs/${encodeURIComponent(orb.id)}`,
  };
}

export function buildDashboardSearchSource(snapshot: DashboardSearchSnapshot): AppSearchSource {
  const items: AppSearchItem[] = [];
  let hasLoadingOrbs = false;
  let hasFailedOrbs = false;

  for (const project of snapshot.projects) {
    items.push(projectItem(project));
    const orbList = snapshot.orbLists[project.id];
    if (orbList === undefined || orbList.type === "loading") {
      hasLoadingOrbs = true;
      continue;
    }
    if (orbList.type === "failed") {
      hasFailedOrbs = true;
      continue;
    }
    const shelves = splitProjectOrbs(orbList.items);
    items.push(...shelves.working.map((orb) => orbItem(project, orb, false, snapshot.now)));
    items.push(...shelves.archive.map((orb) => orbItem(project, orb, true, snapshot.now)));
  }

  const status = snapshot.projectsFailed
    ? ({ type: "partial_error", message: "Projects could not be loaded" } as const)
    : hasFailedOrbs
      ? ({
          type: "partial_error",
          message: hasLoadingOrbs
            ? "Some orbs could not be searched; other orbs are still loading"
            : "Some orbs could not be searched",
        } as const)
      : snapshot.projectsLoading || hasLoadingOrbs
        ? ({
            type: "loading",
            message: "Searching loaded items · some orbs still loading",
          } as const)
        : ({ type: "complete" } as const);

  return {
    id: "dashboard",
    label: "Find projects and orbs",
    items,
    status,
  };
}

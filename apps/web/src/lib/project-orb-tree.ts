import type { OrbView } from "@pi-orb/protocol";
import { projectOrbShelf } from "./project-orbs.ts";

export interface ProjectOrbTreeRow {
  orb: OrbView;
  depth: number;
}

/** Preorder of the already stable working shelf; provenance never changes shelf or ownership. */
export function buildProjectOrbTree(working: readonly OrbView[]): ProjectOrbTreeRow[] {
  const byId = new Map(working.map((orb) => [orb.id, orb]));
  const children = new Map<string, OrbView[]>();
  const roots: OrbView[] = [];
  for (const orb of working) {
    const parent = orb.spawnedBy === undefined ? undefined : byId.get(orb.spawnedBy);
    if (
      parent === undefined ||
      parent.id === orb.id ||
      parent.projectId !== orb.projectId ||
      projectOrbShelf(parent.state) !== "working"
    ) {
      roots.push(orb);
    } else {
      const siblings = children.get(parent.id) ?? [];
      siblings.push(orb);
      children.set(parent.id, siblings);
    }
  }

  const rows: ProjectOrbTreeRow[] = [];
  const visited = new Set<string>();
  const visit = (orb: OrbView) => {
    const pending: ProjectOrbTreeRow[] = [{ orb, depth: 0 }];
    while (pending.length > 0) {
      const row = pending.pop();
      if (row === undefined || visited.has(row.orb.id)) continue;
      visited.add(row.orb.id);
      rows.push(row);
      const descendants = children.get(row.orb.id) ?? [];
      for (let index = descendants.length - 1; index >= 0; index--) {
        const child = descendants[index];
        if (child !== undefined) pending.push({ orb: child, depth: row.depth + 1 });
      }
    }
  };
  for (const root of roots) visit(root);
  // A malformed cycle has no root. Cut its first observed edge, retaining every row once.
  for (const orb of working) {
    if (!visited.has(orb.id)) visit(orb);
  }
  return rows;
}

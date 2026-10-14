import type { OrbView } from "@pi-orb/protocol";
import type { CSSProperties, ReactNode } from "react";
import { buildProjectOrbTree } from "../lib/project-orb-tree.ts";

export function ProjectOrbTree({
  items,
  children,
}: {
  items: readonly OrbView[];
  children: (orb: OrbView) => ReactNode;
}) {
  return (
    <div className="orb-tree">
      {buildProjectOrbTree(items).map(({ orb, depth }) => (
        <div
          key={orb.id}
          className="orb-tree-row"
          data-orb-id={orb.id}
          data-orb-depth={depth}
          style={{ "--orb-depth": depth } as CSSProperties}
        >
          {children(orb)}
        </div>
      ))}
    </div>
  );
}

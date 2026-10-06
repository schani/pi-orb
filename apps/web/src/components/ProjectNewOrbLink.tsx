import type { HarnessKind, ProjectView } from "@pi-orb/protocol";
import type { MouseEventHandler } from "react";
import { HarnessIcon } from "./HarnessIcon.tsx";

export function ProjectNewOrbLink({
  project,
  harness,
  disabled,
  onClick,
}: {
  project: Pick<ProjectView, "id" | "name">;
  harness: HarnessKind;
  disabled: boolean;
  onClick: MouseEventHandler<HTMLAnchorElement>;
}) {
  const label = `New ${harness === "pi" ? "Pi" : "Claude"} orb in ${project.name}`;
  const content = <HarnessIcon harness={harness} />;
  return disabled ? (
    <button
      type="button"
      className="icon-button project-new-orb-icon"
      data-harness={harness}
      aria-label={label}
      title={label}
      disabled
    >
      {content}
    </button>
  ) : (
    <a
      className="icon-button project-new-orb-icon"
      data-harness={harness}
      href={`/projects/${encodeURIComponent(project.id)}/orbs/new?harness=${harness}`}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {content}
    </a>
  );
}

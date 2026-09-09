import type { ProjectView } from "@pi-orb/protocol";
import { useEffect, useRef, useState } from "react";
import { deleteProject, describeApiError } from "../lib/api.ts";
import { projectDeletionConfirmation } from "../lib/project-deletion.ts";
import { Icon } from "./Icons.tsx";
import { ProjectConfigButton } from "./ProjectConfigButton.tsx";

/** Identical project identity and actions on the dashboard and in the orb index. */
export function ProjectHeader({
  project,
  onChanged,
}: {
  project: ProjectView;
  onChanged: (project: ProjectView) => void | Promise<void>;
}) {
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabled = busy || project.state === "deleting";
  const remove = async () => {
    if (disabled || !window.confirm(projectDeletionConfirmation(project.name))) return;
    setBusy(true);
    setError(null);
    const result = await deleteProject(project.id);
    if (!active.current) return;
    setBusy(false);
    if (result.isErr()) setError(describeApiError(result.error));
    else await onChanged(result.value);
  };
  return (
    <div className="project-head">
      <div className="project-head-line project-head-name">
        <h2 className="project-name" data-project-heading tabIndex={-1}>
          {project.name}
        </h2>
        <ProjectConfigButton project={project} disabled={disabled} onChanged={onChanged} />
        <button
          type="button"
          className="icon-button danger"
          aria-label={`Delete ${project.name}`}
          title="delete project"
          disabled={disabled}
          onClick={() => void remove()}
        >
          <Icon name="bin" />
        </button>
      </div>
      {error !== null && (
        <div role="alert" className="banner banner-error project-column-error">
          {error}
        </div>
      )}
    </div>
  );
}

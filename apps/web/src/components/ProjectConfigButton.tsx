import type { ProjectView } from "@pi-orb/protocol";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icons.tsx";
import { ProjectConfigModal } from "./ProjectConfigModal.tsx";

export function ProjectConfigButton({
  project,
  disabled = false,
  onChanged,
}: {
  project: ProjectView;
  disabled?: boolean;
  onChanged: (project: ProjectView) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={button}
        type="button"
        className="icon-button"
        aria-label={`Configure ${project.name}`}
        title="project config"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <Icon name="gear" />
      </button>
      {open &&
        createPortal(
          <ProjectConfigModal
            key={project.id}
            project={project}
            onChanged={onChanged}
            onClose={() => {
              setOpen(false);
              button.current?.focus();
            }}
          />,
          document.body,
        )}
    </>
  );
}

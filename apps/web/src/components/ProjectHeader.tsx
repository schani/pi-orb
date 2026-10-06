import type { CreateOrbRequest, HarnessKind, OrbView, ProjectView } from "@pi-orb/protocol";
import { useContext, useEffect, useRef, useState } from "react";
import { type ApiError, createOrb, deleteProject, describeApiError } from "../lib/api.ts";
import { createOrbRequest } from "../lib/create-orb-request.ts";
import { navigate } from "../lib/navigation.ts";
import { projectDeletionConfirmation } from "../lib/project-deletion.ts";
import { TranscriptCacheContext } from "../lib/transcript-cache-context.ts";
import { generateUuid } from "../lib/uuid.ts";
import { Icon } from "./Icons.tsx";
import { ProjectConfigButton } from "./ProjectConfigButton.tsx";
import { ProjectNewOrbLink } from "./ProjectNewOrbLink.tsx";

/** Identical project identity and actions on the dashboard and in the orb index. */
export function ProjectHeader({
  project,
  onChanged,
  onCreated,
}: {
  project: ProjectView;
  onCreated?: (orb: OrbView) => void;
  onChanged: (project: ProjectView) => void | Promise<void>;
}) {
  const cache = useContext(TranscriptCacheContext);
  useEffect(() => {
    if (project.state === "deleting") cache?.invalidateProject(project.id);
  }, [cache, project.id, project.state]);
  const active = useRef(true);
  const navigation = useRef(0);
  useEffect(() => {
    active.current = project.state !== "deleting";
    const changedRoute = () => {
      navigation.current += 1;
    };
    window.addEventListener("popstate", changedRoute);
    window.addEventListener("pi-orb:navigate", changedRoute);
    return () => {
      active.current = false;
      window.removeEventListener("popstate", changedRoute);
      window.removeEventListener("pi-orb:navigate", changedRoute);
    };
  }, [project.state]);
  const [creation, setCreation] = useState<
    { type: "pending" } | { type: "failed"; error: ApiError } | null
  >(null);
  const creating = useRef(false);
  const request = useRef<CreateOrbRequest | null>(null);
  const create = async (harness: HarnessKind) => {
    if (creating.current || !active.current || busy) return;
    creating.current = true;
    const intent = navigation.current;
    const source = window.location.href;
    if (request.current?.harness !== harness)
      request.current = createOrbRequest(generateUuid(), harness);
    setCreation({ type: "pending" });
    const result = await createOrb(project.id, request.current);
    creating.current = false;
    if (!active.current) return;
    if (result.isErr()) {
      setCreation({ type: "failed", error: result.error });
      return;
    }
    request.current = null;
    setCreation(null);
    onCreated?.(result.value);
    if (navigation.current === intent && window.location.href === source)
      navigate(`/orbs/${encodeURIComponent(result.value.id)}`);
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabled = busy || project.state === "deleting";
  const remove = async () => {
    if (disabled || !window.confirm(projectDeletionConfirmation(project.name))) return;
    navigation.current += 1;
    setBusy(true);
    setError(null);
    const result = await deleteProject(project.id);
    if (result.isOk()) cache?.invalidateProject(project.id);
    if (!active.current) return;
    setBusy(false);
    if (result.isErr()) setError(describeApiError(result.error));
    else {
      active.current = false;
      await onChanged(result.value);
    }
  };
  return (
    <div className="project-head">
      <div className="project-head-line project-head-name">
        <h2 className="project-name" data-project-heading tabIndex={-1}>
          {project.name}
        </h2>
        <span className="project-head-actions">
          {(["pi", "claude"] as const).map((harness) => (
            <ProjectNewOrbLink
              key={harness}
              project={project}
              harness={harness}
              disabled={disabled || creation?.type === "pending"}
              onClick={(event) => {
                if (
                  event.defaultPrevented ||
                  event.button !== 0 ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                )
                  return;
                event.preventDefault();
                void create(harness);
              }}
            />
          ))}
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
        </span>
      </div>
      {creation?.type === "pending" && (
        <div className="project-progress" role="status">
          creating orb…
        </div>
      )}
      {creation?.type === "failed" && (
        <div className="banner banner-error project-column-error" role="alert">
          Failed to create orb: {describeApiError(creation.error)}{" "}
          <button
            type="button"
            className="text-action"
            onClick={() => {
              if (request.current?.harness) void create(request.current.harness);
            }}
          >
            retry
          </button>
        </div>
      )}
      {error !== null && (
        <div role="alert" className="banner banner-error project-column-error">
          {error}
        </div>
      )}
    </div>
  );
}

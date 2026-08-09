import { type OrbView, type ProjectView, validateRepositoryUrl } from "@pi-orb/protocol";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  type ApiError,
  archiveOrb,
  createOrb,
  createProject,
  deleteOrb,
  deleteProject,
  describeApiError,
  listOrbs,
  listProjects,
  updateProject,
} from "../lib/api.ts";
import {
  projectDeletionConfirmation,
  projectDeletionProgressText,
} from "../lib/project-deletion.ts";
import {
  projectOrbActions,
  projectOrbFaviconStatus,
  splitProjectOrbs,
} from "../lib/project-orbs.ts";
import { generateUuid } from "../lib/uuid.ts";

type OrbListState =
  | { type: "loading" }
  | { type: "loaded"; items: OrbView[] }
  | { type: "failed"; error: ApiError };

interface ProjectOrbShelvesProps {
  items: OrbView[];
  archivingOrb: string | null;
  deletingOrb: string | null;
  onArchive(orb: OrbView): Promise<void>;
  onDelete(orb: OrbView): Promise<void>;
}

function ProjectOrbRow({
  orb,
  archivingOrb,
  deletingOrb,
  onArchive,
  onDelete,
}: Omit<ProjectOrbShelvesProps, "items"> & { orb: OrbView }) {
  const actions = projectOrbActions(orb.state);
  const favicon = projectOrbFaviconStatus(orb.state);
  const blocker =
    orb.state === "deleting" &&
    orb.stateDetail?.type === "deleting_resources" &&
    orb.stateDetail.message !== undefined
      ? orb.stateDetail.message
      : null;

  return (
    <div className="project-orb-row">
      <div className="project-orb-identity">
        <a className="project-orb-link" href={`#/orbs/${orb.id}`}>
          <span
            className="project-orb-state"
            role="img"
            aria-label={`State: ${orb.state}`}
            title={orb.state}
          >
            <img src={`/favicons/${favicon}.svg`} alt="" />
            <span className="project-orb-state-tooltip" role="tooltip">
              {orb.state}
            </span>
          </span>
          <span className="project-orb-name">
            {orb.name ?? "untitled orb"}
            <span className="muted mono"> · {orb.id.slice(0, 8)}</span>
          </span>
        </a>
      </div>
      {blocker !== null && <span className="project-orb-blocker">{blocker}</span>}
      <div className="project-orb-actions">
        {actions.archive && (
          <button
            type="button"
            className="project-orb-action"
            disabled={archivingOrb === orb.id}
            onClick={() => void onArchive(orb)}
          >
            {archivingOrb === orb.id ? "archiving…" : "archive"}
          </button>
        )}
        {actions.delete && (
          <button
            type="button"
            className="project-orb-action danger"
            disabled={deletingOrb === orb.id}
            onClick={() => void onDelete(orb)}
          >
            {deletingOrb === orb.id ? "deleting…" : "delete"}
          </button>
        )}
      </div>
    </div>
  );
}

function ProjectOrbShelves(props: ProjectOrbShelvesProps) {
  const shelves = splitProjectOrbs(props.items);
  const row = (orb: OrbView) => <ProjectOrbRow key={orb.id} orb={orb} {...props} />;

  return (
    <div className="project-orb-shelves">
      <section className="project-orb-shelf">
        <h3>
          working set <span>{shelves.working.length}</span>
        </h3>
        {shelves.working.length === 0 ? (
          <p className="project-orb-shelf-empty">no working orbs</p>
        ) : (
          shelves.working.map(row)
        )}
      </section>
      <section className="project-orb-shelf project-orb-archive-shelf">
        <h3>
          archive shelf <span>{shelves.archive.length}</span>
        </h3>
        {shelves.archive.length === 0 ? (
          <p className="project-orb-shelf-empty">no archived orbs</p>
        ) : (
          shelves.archive.map(row)
        )}
      </section>
    </div>
  );
}

export function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectView[] | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [orbLists, setOrbLists] = useState<Record<string, OrbListState | undefined>>({});

  const [name, setName] = useState("");
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [creatingOrbFor, setCreatingOrbFor] = useState<string | null>(null);
  const [deletingProject, setDeletingProject] = useState<string | null>(null);
  const [renamingProject, setRenamingProject] = useState<string | null>(null);
  const [projectRenameText, setProjectRenameText] = useState("");
  const [projectRenameError, setProjectRenameError] = useState<string | null>(null);
  const [savingProjectName, setSavingProjectName] = useState(false);
  const projectRenameInputRef = useRef<HTMLInputElement>(null);
  const [deletingOrb, setDeletingOrb] = useState<string | null>(null);
  const [archivingOrb, setArchivingOrb] = useState<string | null>(null);
  const [orbCreateError, setOrbCreateError] = useState<{
    projectId: string;
    message: string;
  } | null>(null);

  const refresh = useCallback(async () => {
    const result = await listProjects();
    if (result.isErr()) {
      setLoadError(result.error);
      return;
    }
    setLoadError(null);
    setProjects(result.value.items);
    setOrbLists((previous) => {
      const next: Record<string, OrbListState | undefined> = {};
      for (const project of result.value.items) {
        next[project.id] = previous[project.id] ?? { type: "loading" };
      }
      return next;
    });
    const entries = await Promise.all(
      result.value.items.map(async (project) => [project.id, await listOrbs(project.id)] as const),
    );
    setOrbLists(
      Object.fromEntries(
        entries.map(([projectId, orbsResult]) => [
          projectId,
          orbsResult.isOk()
            ? ({ type: "loaded", items: orbsResult.value.items } satisfies OrbListState)
            : ({ type: "failed", error: orbsResult.error } satisfies OrbListState),
        ]),
      ),
    );
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (renamingProject !== null) projectRenameInputRef.current?.focus();
  }, [renamingProject]);

  // A deleting row remains visible through the race-fencing quarantine. Poll
  // until finalization removes it instead of requiring a manual page reload.
  useEffect(() => {
    const deletionInProgress =
      projects?.some((project) => project.state === "deleting") === true ||
      Object.values(orbLists).some(
        (list) =>
          list?.type === "loaded" &&
          list.items.some((orb) => orb.state === "deleting" || orb.state === "archiving"),
      );
    if (!deletionInProgress) return;
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => window.clearInterval(timer);
  }, [orbLists, projects, refresh]);

  const onCreateProject = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedUrl = repositoryUrl.trim();
    const validated = validateRepositoryUrl(trimmedUrl);
    if (validated.isErr()) {
      setUrlError(validated.error.message);
      return;
    }
    setUrlError(null);
    if (trimmedName === "") {
      setFormError("project name is required");
      return;
    }
    setFormError(null);
    setSubmitting(true);
    const result = await createProject({
      id: generateUuid(),
      name: trimmedName,
      repositoryUrl: trimmedUrl,
    });
    setSubmitting(false);
    if (result.isErr()) {
      setFormError(describeApiError(result.error));
      return;
    }
    setName("");
    setRepositoryUrl("");
    refresh();
  };

  const onRenameProject = async (project: ProjectView) => {
    const trimmedName = projectRenameText.trim();
    if (trimmedName === "") {
      setProjectRenameError("project name is required");
      return;
    }
    setSavingProjectName(true);
    setProjectRenameError(null);
    const result = await updateProject(project.id, { name: trimmedName });
    setSavingProjectName(false);
    if (result.isErr()) {
      setProjectRenameError(describeApiError(result.error));
      return;
    }
    const renamed = result.value;
    setProjects(
      (current) => current?.map((item) => (item.id === project.id ? renamed : item)) ?? null,
    );
    setRenamingProject(null);
  };

  const onDeleteProject = async (project: ProjectView) => {
    if (!window.confirm(projectDeletionConfirmation(project.name))) return;
    setDeletingProject(project.id);
    setFormError(null);
    const result = await deleteProject(project.id);
    setDeletingProject(null);
    if (result.isErr()) {
      setFormError(describeApiError(result.error));
      return;
    }
    await refresh();
  };

  const onArchiveOrb = async (orb: OrbView) => {
    if (
      !window.confirm(
        `Archive ${orb.name ?? "this orb"}? Its checkout, files, compute, and port access will be permanently deleted. Its conversation will remain readable, but the orb can never start again.`,
      )
    )
      return;
    setArchivingOrb(orb.id);
    const result = await archiveOrb(orb.id);
    setArchivingOrb(null);
    if (result.isErr()) {
      setOrbCreateError({ projectId: orb.projectId, message: describeApiError(result.error) });
      return;
    }
    await refresh();
  };

  const onDeleteOrb = async (orb: OrbView) => {
    if (
      !window.confirm(
        `Delete ${orb.name ?? "this orb"} permanently? Its checkout, files, and conversation history will be lost.`,
      )
    )
      return;
    setDeletingOrb(orb.id);
    const result = await deleteOrb(orb.id);
    setDeletingOrb(null);
    if (result.isErr()) {
      setOrbCreateError({ projectId: orb.projectId, message: describeApiError(result.error) });
      return;
    }
    await refresh();
  };

  const onCreateOrb = async (projectId: string) => {
    setCreatingOrbFor(projectId);
    setOrbCreateError(null);
    const result = await createOrb(projectId, { id: generateUuid() });
    setCreatingOrbFor(null);
    if (result.isErr()) {
      setOrbCreateError({ projectId, message: describeApiError(result.error) });
      return;
    }
    window.location.hash = `#/orbs/${result.value.id}`;
  };

  return (
    <main className="page projects-page">
      {loadError !== null && (
        <div className="banner banner-error">
          failed to load projects: {describeApiError(loadError)}
        </div>
      )}
      {projects !== null && projects.length === 0 && <p className="muted">No projects yet.</p>}
      {projects?.map((project) => {
        const orbList = orbLists[project.id] ?? { type: "loading" as const };
        return (
          <section className="panel project" key={project.id}>
            <div className="project-header">
              {renamingProject === project.id ? (
                <form
                  className="project-rename-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void onRenameProject(project);
                  }}
                >
                  <input
                    ref={projectRenameInputRef}
                    aria-label="project name"
                    value={projectRenameText}
                    maxLength={80}
                    onChange={(event) => setProjectRenameText(event.target.value)}
                  />
                  <button type="submit" disabled={savingProjectName}>
                    {savingProjectName ? "saving…" : "save"}
                  </button>
                  <button
                    type="button"
                    disabled={savingProjectName}
                    onClick={() => {
                      setRenamingProject(null);
                      setProjectRenameError(null);
                    }}
                  >
                    cancel
                  </button>
                </form>
              ) : (
                <div className="project-name">
                  <h2>{project.name}</h2>
                  <button
                    type="button"
                    className="project-rename-button"
                    aria-label={`Rename ${project.name}`}
                    title="Rename project"
                    disabled={project.state === "deleting"}
                    onClick={() => {
                      setProjectRenameText(project.name);
                      setProjectRenameError(null);
                      setRenamingProject(project.id);
                    }}
                  >
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M12 20h9" />
                      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
                    </svg>
                  </button>
                </div>
              )}
              <span className="muted mono">{project.repositoryUrl}</span>
              <span className={`state-badge state-${project.state}`}>{project.state}</span>
              <div className="project-header-actions">
                <button
                  type="button"
                  onClick={() => onCreateOrb(project.id)}
                  disabled={creatingOrbFor === project.id || project.state === "deleting"}
                >
                  {creatingOrbFor === project.id ? "creating…" : "new orb"}
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={project.state === "deleting" || deletingProject === project.id}
                  onClick={() => void onDeleteProject(project)}
                >
                  {project.state === "deleting" || deletingProject === project.id
                    ? "deleting project…"
                    : "delete project"}
                </button>
              </div>
            </div>
            {renamingProject === project.id && projectRenameError !== null && (
              <div className="banner banner-error">{projectRenameError}</div>
            )}
            {project.deletionProgress !== undefined && (
              <div
                className={project.deletionProgress.blocked > 0 ? "banner banner-error" : "muted"}
              >
                {projectDeletionProgressText(project.deletionProgress)}
              </div>
            )}
            {orbList.type === "loading" && <p className="muted">loading orbs…</p>}
            {orbList.type === "failed" && (
              <div className="banner banner-error">
                failed to load orbs: {describeApiError(orbList.error)}
              </div>
            )}
            {orbList.type === "loaded" &&
              (orbList.items.length === 0 ? (
                <p className="muted">no orbs</p>
              ) : (
                <ProjectOrbShelves
                  items={orbList.items}
                  archivingOrb={archivingOrb}
                  deletingOrb={deletingOrb}
                  onArchive={onArchiveOrb}
                  onDelete={onDeleteOrb}
                />
              ))}
            {orbCreateError !== null && orbCreateError.projectId === project.id && (
              <div className="banner banner-error">{orbCreateError.message}</div>
            )}
          </section>
        );
      })}

      <section className="panel new-project-panel">
        <div className="project-form-heading">
          <h1>New Project</h1>
          <p>Connect a repository and start a fresh workspace.</p>
        </div>
        <form className="project-form" onSubmit={onCreateProject}>
          <label>
            name
            <input
              type="text"
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              placeholder="my project"
            />
          </label>
          <label>
            repository URL
            <input
              type="text"
              value={repositoryUrl}
              onChange={(event) => setRepositoryUrl(event.target.value)}
              placeholder="https://github.com/owner/repo or git@github.com:owner/repo.git"
            />
          </label>
          <button type="submit" disabled={submitting}>
            {submitting ? "creating…" : "create project"}
          </button>
          {urlError !== null && (
            <div className="banner banner-error project-form-error">{urlError}</div>
          )}
          {formError !== null && (
            <div className="banner banner-error project-form-error">{formError}</div>
          )}
        </form>
      </section>
    </main>
  );
}

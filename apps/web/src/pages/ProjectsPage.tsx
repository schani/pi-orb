import { type OrbView, type ProjectView, validateRepositoryUrl } from "@pi-orb/protocol";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import {
  type ApiError,
  archiveOrb,
  createOrb,
  createProject,
  deleteOrb,
  describeApiError,
  listOrbs,
  listProjects,
} from "../lib/api.ts";
import { generateUuid } from "../lib/uuid.ts";

type OrbListState =
  | { type: "loading" }
  | { type: "loaded"; items: OrbView[] }
  | { type: "failed"; error: ApiError };

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

  // A deleting row remains visible through the race-fencing quarantine. Poll
  // until finalization removes it instead of requiring a manual page reload.
  useEffect(() => {
    const deletionInProgress = Object.values(orbLists).some(
      (list) =>
        list?.type === "loaded" &&
        list.items.some((orb) => orb.state === "deleting" || orb.state === "archiving"),
    );
    if (!deletionInProgress) return;
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => window.clearInterval(timer);
  }, [orbLists, refresh]);

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
      <section className="panel">
        <h1>projects</h1>
        <form className="project-form" onSubmit={onCreateProject}>
          <label>
            name
            <input
              type="text"
              value={name}
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
              placeholder="https://github.com/owner/repo"
            />
          </label>
          <button type="submit" disabled={submitting}>
            {submitting ? "creating…" : "create project"}
          </button>
          {urlError !== null && <div className="banner banner-error">{urlError}</div>}
          {formError !== null && <div className="banner banner-error">{formError}</div>}
        </form>
      </section>

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
              <h2>{project.name}</h2>
              <span className="muted mono">{project.repositoryUrl}</span>
            </div>
            {orbList.type === "loading" && <p className="muted">loading orbs…</p>}
            {orbList.type === "failed" && (
              <div className="banner banner-error">
                failed to load orbs: {describeApiError(orbList.error)}
              </div>
            )}
            {orbList.type === "loaded" && (
              <ul className="orb-list">
                {orbList.items.length === 0 && <li className="muted">no orbs</li>}
                {orbList.items.map((orb) => (
                  <li key={orb.id}>
                    <a href={`#/orbs/${orb.id}`}>
                      {orb.name ?? "untitled orb"}
                      <span className="muted mono"> · {orb.id.slice(0, 8)}</span>
                    </a>
                    <span className={`state-badge state-${orb.state}`}>{orb.state}</span>
                    <button
                      type="button"
                      disabled={
                        orb.state === "deleting" ||
                        orb.state === "archiving" ||
                        orb.state === "archived" ||
                        archivingOrb === orb.id
                      }
                      onClick={() => void onArchiveOrb(orb)}
                    >
                      {orb.state === "archiving" || archivingOrb === orb.id
                        ? "archiving…"
                        : "archive"}
                    </button>
                    <button
                      type="button"
                      className="danger"
                      disabled={orb.state === "deleting" || deletingOrb === orb.id}
                      onClick={() => void onDeleteOrb(orb)}
                    >
                      {orb.state === "deleting" || deletingOrb === orb.id ? "deleting…" : "delete"}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              onClick={() => onCreateOrb(project.id)}
              disabled={creatingOrbFor === project.id}
            >
              {creatingOrbFor === project.id ? "creating…" : "new orb"}
            </button>
            {orbCreateError !== null && orbCreateError.projectId === project.id && (
              <div className="banner banner-error">{orbCreateError.message}</div>
            )}
          </section>
        );
      })}
    </main>
  );
}

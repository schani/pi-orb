import {
  type OrbView,
  type ProjectView,
  type SystemView,
  validateRepositoryUrl,
} from "@pi-orb/protocol";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppSearchSource } from "../components/AppSearch.tsx";
import { Icon } from "../components/Icons.tsx";
import { ProjectConfigModal } from "../components/ProjectConfigModal.tsx";
import { ProjectHeader } from "../components/ProjectHeader.tsx";
import { ProjectNewOrbLink } from "../components/ProjectNewOrbLink.tsx";
import { StateTile } from "../components/StateTile.tsx";
import {
  type ApiError,
  archiveOrb,
  createProject,
  deleteOrb,
  describeApiError,
  getSystem,
  listOrbs,
  listProjects,
} from "../lib/api.ts";
import { buildDashboardSearchSource } from "../lib/dashboard-search-source.ts";
import { projectDeletionProgressText } from "../lib/project-deletion.ts";
import {
  dashboardTotals,
  formatProjectOrbAge,
  orderProjects,
  projectOrbActions,
  projectOrbGlyph,
  splitProjectOrbs,
} from "../lib/project-orbs.ts";
import { generateUuid } from "../lib/uuid.ts";
import { NotFoundPage } from "./NotFoundPage.tsx";

type OrbListState =
  | { type: "loading" }
  | { type: "loaded"; items: OrbView[] }
  | { type: "failed"; error: ApiError };

interface OrbEntryProps {
  orb: OrbView;
  now: number;
  archivingOrb: string | null;
  deletingOrb: string | null;
  onArchive(orb: OrbView): Promise<void>;
  onDelete(orb: OrbView): Promise<void>;
}

function OrbEntry({ orb, now, archivingOrb, deletingOrb, onArchive, onDelete }: OrbEntryProps) {
  const actions = projectOrbActions(orb.state);
  const glyph = projectOrbGlyph(orb.state, orb.activity);
  const name = orb.name ?? "untitled orb";
  const age = formatProjectOrbAge(orb.updatedAt, now);
  const blocker =
    orb.state === "deleting" &&
    orb.stateDetail?.type === "deleting_resources" &&
    orb.stateDetail.message !== undefined
      ? orb.stateDetail.message
      : null;

  return (
    <div className={`orb-entry orb-entry-${glyph.state}`}>
      <div className="orb-entry-title">
        <StateTile glyph={glyph} />
        <a className="orb-entry-link" href={`#/orbs/${orb.id}`}>
          {name}
        </a>
      </div>
      <div className="orb-entry-meta">
        {age !== null && <span>{age}</span>}
        <span className="orb-entry-actions">
          {actions.archive && (
            <button
              type="button"
              className="icon-button"
              aria-label={`Archive ${name}`}
              title="archive"
              disabled={archivingOrb === orb.id}
              onClick={() => void onArchive(orb)}
            >
              <Icon name="archive" />
            </button>
          )}
          {actions.delete && (
            <button
              type="button"
              className="icon-button danger"
              aria-label={`Delete ${name}`}
              title="delete"
              disabled={deletingOrb === orb.id}
              onClick={() => void onDelete(orb)}
            >
              <Icon name="bin" />
            </button>
          )}
        </span>
      </div>
      {orb.state === "failed" && orb.lastError !== undefined && (
        <div className="orb-entry-detail orb-entry-error" title={orb.lastError}>
          {orb.lastError}
        </div>
      )}
      {blocker !== null && <div className="orb-entry-detail">{blocker}</div>}
    </div>
  );
}

function ProjectArchive({ items, ...entry }: Omit<OrbEntryProps, "orb"> & { items: OrbView[] }) {
  if (items.length === 0) return null;
  return (
    <details className="project-archive">
      <summary>archive · {items.length}</summary>
      <div className="project-archive-body">
        {items.map((orb) => (
          <OrbEntry key={orb.id} orb={orb} {...entry} />
        ))}
      </div>
    </details>
  );
}

interface ProjectsPageProps {
  focusedProjectId?: string | null;
  mcpConfigOpen?: boolean;
}

export function ProjectsPage({
  focusedProjectId = null,
  mcpConfigOpen = false,
}: ProjectsPageProps) {
  const [projects, setProjects] = useState<ProjectView[] | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [orbLists, setOrbLists] = useState<Record<string, OrbListState | undefined>>({});
  const [system, setSystem] = useState<SystemView | null>(null);

  const [name, setName] = useState("");
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [deletingOrb, setDeletingOrb] = useState<string | null>(null);
  const [archivingOrb, setArchivingOrb] = useState<string | null>(null);
  const [ageNow, setAgeNow] = useState(() => Date.now());
  const [orbCreateError, setOrbCreateError] = useState<{
    projectId: string;
    message: string;
  } | null>(null);
  const focusedProjectRef = useRef<HTMLElement>(null);
  const lastFocusedProjectIdRef = useRef<string | null>(null);

  const focusedProjectMissing =
    focusedProjectId !== null &&
    projects !== null &&
    !projects.some((project) => project.id === focusedProjectId);
  const searchSource = useMemo(
    () =>
      buildDashboardSearchSource({
        projects: projects ?? [],
        projectsLoading: projects === null && loadError === null,
        projectsFailed: projects === null && loadError !== null,
        orbLists,
        now: ageNow,
      }),
    [ageNow, loadError, orbLists, projects],
  );
  useAppSearchSource(focusedProjectMissing ? null : searchSource);

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
    const orbEntries = await Promise.all(
      result.value.items.map(async (project) => [project.id, await listOrbs(project.id)] as const),
    );
    setOrbLists(
      Object.fromEntries(
        orbEntries.map(([projectId, orbsResult]) => [
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
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refreshSystem = async (): Promise<void> => {
      const result = await getSystem();
      if (stopped) return;
      if (result.isOk()) setSystem(result.value);
      timer = setTimeout(() => void refreshSystem(), 10_000);
    };
    void refreshSystem();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setAgeNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (focusedProjectId === null) {
      lastFocusedProjectIdRef.current = null;
      return;
    }
    if (
      projects === null ||
      !projects.some((project) => project.id === focusedProjectId) ||
      lastFocusedProjectIdRef.current === focusedProjectId
    ) {
      return;
    }
    lastFocusedProjectIdRef.current = focusedProjectId;
    focusedProjectRef.current?.scrollIntoView({ block: "center" });
    if (!mcpConfigOpen)
      focusedProjectRef.current?.querySelector<HTMLElement>("[data-project-heading]")?.focus();
  }, [focusedProjectId, projects, mcpConfigOpen]);

  // Keep names and activity current, including when no lifecycle work is pending.
  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

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

  if (focusedProjectMissing) return <NotFoundPage resourceName="Project" />;

  const loadedOrbs = Object.fromEntries(
    Object.entries(orbLists).map(([projectId, list]) => [
      projectId,
      list?.type === "loaded" ? list.items : [],
    ]),
  );
  const ordered = projects === null ? [] : orderProjects(projects, loadedOrbs);
  const totals = dashboardTotals(projects ?? [], loadedOrbs);
  const configProject = mcpConfigOpen
    ? projects?.find((project) => project.id === focusedProjectId)
    : undefined;

  return (
    <main className="projects-page">
      <div className="dashboard-totals">
        <span className="dashboard-total">
          <b>{totals.projects}</b>
          <span>{totals.projects === 1 ? "project" : "projects"}</span>
        </span>
        <span className="dashboard-total">
          <b>{totals.orbs}</b>
          <span>{totals.orbs === 1 ? "orb" : "orbs"}</span>
        </span>
        <span className="dashboard-total">
          <b>{totals.busy}</b>
          <span>busy</span>
        </span>
        <span className="dashboard-total">
          <b>{totals.failed}</b>
          <span>failed</span>
        </span>
      </div>
      {loadError !== null && (
        <div className="banner banner-error">
          failed to load projects: {describeApiError(loadError)}
        </div>
      )}
      <div className="dashboard">
        {ordered.map((project) => {
          const orbList = orbLists[project.id] ?? { type: "loading" as const };
          const deleting = project.state === "deleting";
          const shelves = splitProjectOrbs(orbList.type === "loaded" ? orbList.items : []);
          const entryProps = {
            now: ageNow,
            archivingOrb,
            deletingOrb,
            onArchive: onArchiveOrb,
            onDelete: onDeleteOrb,
          };
          return (
            <section
              id={`project-${project.id}`}
              ref={project.id === focusedProjectId ? focusedProjectRef : undefined}
              className={`project-column${deleting ? " project-column-deleting" : ""}`}
              key={project.id}
            >
              <ProjectHeader
                project={project}
                onChanged={async (changed) => {
                  setProjects(
                    (current) =>
                      current?.map((item) => (item.id === changed.id ? changed : item)) ?? null,
                  );
                  await refresh();
                }}
              />
              {deleting ? (
                <div className="project-progress">
                  {project.deletionProgress === undefined
                    ? "deleting project…"
                    : `… ${projectDeletionProgressText(project.deletionProgress)}`}
                </div>
              ) : (
                <>
                  {orbList.type === "loading" && <div className="project-progress">loading…</div>}
                  {orbList.type === "failed" && (
                    <div className="banner banner-error project-column-error">
                      failed to load orbs: {describeApiError(orbList.error)}
                    </div>
                  )}
                  {shelves.working.map((orb) => (
                    <OrbEntry key={orb.id} orb={orb} {...entryProps} />
                  ))}
                  {orbList.type === "loaded" && (
                    <ProjectArchive items={shelves.archive} {...entryProps} />
                  )}
                </>
              )}
              <div className="project-new-orb-row">
                <ProjectNewOrbLink projectId={project.id} disabled={deleting} />
              </div>
              {orbCreateError !== null && orbCreateError.projectId === project.id && (
                <div className="banner banner-error project-column-error">
                  {orbCreateError.message}
                </div>
              )}
            </section>
          );
        })}

        <section className="new-project">
          <h2>New project</h2>
          <form onSubmit={onCreateProject}>
            <label>
              project name
              <input
                type="text"
                value={name}
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label>
              repository URL
              <input
                type="text"
                value={repositoryUrl}
                onChange={(event) => setRepositoryUrl(event.target.value)}
              />
            </label>
            <button type="submit" disabled={submitting}>
              {submitting ? "creating…" : "Create project"}
            </button>
            {urlError !== null && <div className="banner banner-error">{urlError}</div>}
            {formError !== null && <div className="banner banner-error">{formError}</div>}
          </form>
        </section>
      </div>

      {configProject && (
        <ProjectConfigModal
          key={configProject.id}
          project={configProject}
          initialTabIndex={1}
          onChanged={(changed) => {
            setProjects(
              (current) =>
                current?.map((project) => (project.id === changed.id ? changed : project)) ?? null,
            );
          }}
          onClose={() => {
            window.location.hash = `/projects/${configProject.id}`;
          }}
        />
      )}

      <div className="dashboard-footer">
        {system !== null && (
          <>
            <span>{system.hostProvider} host</span>
            <span className="dashboard-footer-separator">·</span>
            <span>{system.databaseKind}</span>
            <span className="dashboard-footer-separator">·</span>
            <span>v{system.version}</span>
            {system.deploymentStatus !== undefined && (
              <a href="https://github.com/schani/pi-orb/actions/workflows/deploy.yml">
                {system.deploymentStatus === "awaiting-activation"
                  ? "Deployment awaiting activation"
                  : system.deploymentStatus === "superseded"
                    ? "Deployment superseded"
                    : "Deployment activation unavailable"}
              </a>
            )}
          </>
        )}
      </div>
    </main>
  );
}

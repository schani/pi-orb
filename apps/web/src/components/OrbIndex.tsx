import type { OrbView, ProjectView } from "@pi-orb/protocol";
import { useEffect, useRef, useState } from "react";
import { type ApiError, createOrb, describeApiError, listOrbs, listProjects } from "../lib/api.ts";
import { FAVICON_HREFS } from "../lib/favicon.ts";
import { projectDeletionProgressText } from "../lib/project-deletion.ts";
import { formatProjectOrbAge, projectOrbGlyph, splitProjectOrbs } from "../lib/project-orbs.ts";
import { generateUuid } from "../lib/uuid.ts";
import { ProjectHeader } from "./ProjectHeader.tsx";
import { StateTile } from "./StateTile.tsx";

interface OrbList {
  items: OrbView[] | null;
  error: ApiError | null;
}

/** Preserve spatial order while refreshing metadata, appending new projects and removing missing ones. */
export function mergeIndexProjects(
  previous: ProjectView[],
  incoming: ProjectView[],
): ProjectView[] {
  const remaining = new Map(incoming.map((project) => [project.id, project]));
  const retained: ProjectView[] = [];
  for (const project of previous) {
    const refreshed = remaining.get(project.id);
    if (refreshed !== undefined) retained.push(refreshed);
    remaining.delete(project.id);
  }
  return [...retained, ...remaining.values()];
}

function IndexRow({
  orb,
  orbId,
  pending,
  now,
}: {
  orb: OrbView;
  orbId: string;
  pending: boolean;
  now: number;
}) {
  const glyph = projectOrbGlyph(orb.state, orb.activity);
  const current = orb.id === orbId;
  const name = orb.name ?? "untitled orb";
  return (
    <a
      className={`ix-row ix-row-${glyph.state}${current ? " ix-row-current" : ""}`}
      href={`#/orbs/${orb.id}`}
      title={name}
      {...(current ? { "aria-current": "page" as const } : {})}
    >
      <StateTile glyph={glyph} />
      <span className="trunc">{name}</span>
      <span className="ix-age">
        {current && pending ? "…" : formatProjectOrbAge(orb.updatedAt, now)}
      </span>
    </a>
  );
}

export function IndexProject({
  project,
  list,
  orbId,
  pending,
  now,
  onChanged,
  onCreated,
}: {
  project: ProjectView;
  list: OrbList | undefined;
  orbId: string;
  pending: boolean;
  now: number;
  onChanged: (project: ProjectView) => void;
  onCreated: (orb: OrbView) => void;
}) {
  const [creation, setCreation] = useState<
    { id: string; type: "pending" } | { id: string; type: "failed"; error: ApiError } | null
  >(null);
  const creating = useRef(false);
  const active = useRef(true);
  const navigation = useRef(0);
  useEffect(() => {
    active.current = project.state !== "deleting";
    const changedRoute = () => {
      navigation.current += 1;
    };
    window.addEventListener("hashchange", changedRoute);
    return () => {
      active.current = false;
      window.removeEventListener("hashchange", changedRoute);
    };
  }, [project.state]);
  const create = async (id: string) => {
    if (creating.current || !active.current) return;
    creating.current = true;
    const intent = navigation.current;
    const sourceHash = window.location.hash;
    setCreation({ id, type: "pending" });
    const result = await createOrb(project.id, { id });
    creating.current = false;
    if (!active.current) return;
    if (result.isErr()) {
      setCreation({ id, type: "failed", error: result.error });
      return;
    }
    setCreation(null);
    onCreated(result.value);
    // A later navigation wins over a slow create response, but the new row still appears.
    if (navigation.current === intent && window.location.hash === sourceHash) {
      window.location.hash = `#/orbs/${result.value.id}`;
    }
  };
  const shelves = splitProjectOrbs(list?.items ?? []);
  const currentArchived = shelves.archive.some((orb) => orb.id === orbId);
  const [archiveOpen, setArchiveOpen] = useState(currentArchived);
  useEffect(() => {
    if (currentArchived) setArchiveOpen(true);
  }, [currentArchived]);
  const rows = (orbs: OrbView[]) =>
    orbs.map((orb) => (
      <IndexRow key={orb.id} orb={orb} orbId={orbId} pending={pending} now={now} />
    ));
  return (
    <section className="ix-project" aria-label={project.name}>
      <ProjectHeader
        project={project}
        orbCreation={{
          pending: creation?.type === "pending",
          onClick: (event) => {
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
            void create(creation?.id ?? generateUuid());
          },
        }}
        onChanged={onChanged}
      />
      {project.state === "deleting" ? (
        <div className="project-progress">
          {project.deletionProgress === undefined
            ? "deleting project…"
            : `… ${projectDeletionProgressText(project.deletionProgress)}`}
        </div>
      ) : (
        <>
          {creation?.type === "pending" && (
            <div className="project-progress" role="status">
              creating orb…
            </div>
          )}
          {creation?.type === "failed" && (
            <div className="banner banner-error ix-load-error" role="alert">
              Failed to create orb: {describeApiError(creation.error)}{" "}
              <button
                type="button"
                className="text-action"
                onClick={() => void create(creation.id)}
              >
                retry
              </button>
            </div>
          )}
          {list?.items == null && list?.error == null && (
            <div className="project-progress" role="status">
              loading…
            </div>
          )}
          {list?.error != null && (
            <div className="banner banner-error ix-load-error" role="alert">
              {list.items === null ? "Failed to load orbs" : "Orb list is stale"}:{" "}
              {describeApiError(list.error)}
            </div>
          )}
          {rows(shelves.working)}
          {shelves.archive.length > 0 && (
            <details
              className="project-archive"
              open={archiveOpen}
              onToggle={(event) => setArchiveOpen(event.currentTarget.open)}
            >
              <summary>archive · {shelves.archive.length}</summary>
              <div className="project-archive-body">{rows(shelves.archive)}</div>
            </details>
          )}
        </>
      )}
    </section>
  );
}

/** The whole fleet stays mounted across both same-project and cross-project orb switches. */
export function OrbIndex({
  projectId,
  orbId,
  pending,
  onProjectChange,
}: {
  projectId: string | null;
  orbId: string;
  pending: boolean;
  onProjectChange: (project: { id: string; name: string } | null) => void;
}) {
  const [projects, setProjects] = useState<ProjectView[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [lists, setLists] = useState<Record<string, OrbList>>({});
  const [now, setNow] = useState(() => Date.now());
  // Completed config/delete/create mutations fence reads that began before they committed.
  const revision = useRef(0);
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      const started = revision.current;
      const result = await listProjects();
      if (cancelled || started !== revision.current) {
        inFlight = false;
        return;
      }
      if (result.isErr()) {
        setError(result.error);
        inFlight = false;
        return;
      }
      setError(null);
      const incoming = result.value.items;
      setProjects((previous) => mergeIndexProjects(previous ?? [], incoming));
      setLists((previous) =>
        Object.fromEntries(
          incoming.map((project) => [
            project.id,
            previous[project.id] ?? { items: null, error: null },
          ]),
        ),
      );
      await Promise.all(
        incoming.map(async (project) => {
          const orbs = await listOrbs(project.id);
          if (cancelled || started !== revision.current) return;
          setLists((previous) => ({
            ...previous,
            [project.id]: orbs.isOk()
              ? { items: orbs.value.items, error: null }
              : { items: previous[project.id]?.items ?? null, error: orbs.error },
          }));
        }),
      );
      inFlight = false;
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
  const currentName = projects?.find((project) => project.id === projectId)?.name ?? null;
  useEffect(() => {
    onProjectChange(
      projectId !== null && currentName !== null ? { id: projectId, name: currentName } : null,
    );
  }, [projectId, currentName, onProjectChange]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <nav className="orb-index" aria-label="All project orbs" aria-busy={pending}>
      <a className="ix-brand up" href="#/">
        <img src={FAVICON_HREFS.neutral} width={16} height={16} alt="" />
        pi-orb
      </a>
      {projects === null && error === null && (
        <div className="project-progress" role="status">
          loading projects…
        </div>
      )}
      {error !== null && (
        <div className="banner banner-error ix-load-error" role="alert">
          {projects === null ? "Failed to load projects" : "Project list is stale"}:{" "}
          {describeApiError(error)}
        </div>
      )}
      {projects?.map((project) => (
        <IndexProject
          key={project.id}
          project={project}
          list={lists[project.id]}
          orbId={orbId}
          pending={pending}
          now={now}
          onCreated={(created) => {
            revision.current += 1;
            setLists((previous) => ({
              ...previous,
              [created.projectId]: {
                items: [
                  ...(previous[created.projectId]?.items ?? []).filter(
                    (entry) => entry.id !== created.id,
                  ),
                  created,
                ],
                error: previous[created.projectId]?.error ?? null,
              },
            }));
          }}
          onChanged={(changed) => {
            revision.current += 1;
            setProjects(
              (previous) =>
                previous?.map((entry) => (entry.id === changed.id ? changed : entry)) ?? null,
            );
            if (changed.state === "deleting" && changed.id === projectId)
              window.location.hash = "#/";
          }}
        />
      ))}
    </nav>
  );
}

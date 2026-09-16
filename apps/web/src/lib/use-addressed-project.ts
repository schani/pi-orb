import type { OrbView, ProjectView } from "@pi-orb/protocol";
import { type RefObject, useCallback, useEffect, useState } from "react";
import { type ApiError, getProject, listOrbs } from "./api.ts";

export interface AddressedProjectSnapshot {
  id: string;
  project: ProjectView | null;
  error: ApiError | null;
  orbs: {
    items: OrbView[] | null;
    error: ApiError | null;
  };
}

export function useAddressedProject(
  projectId: string | null,
  projectInDefault: boolean | null,
  mutationRevision: RefObject<number>,
) {
  const [stored, setStored] = useState<AddressedProjectSnapshot | null>(null);
  const snapshot = projectId !== null && stored?.id === projectId ? stored : null;

  useEffect(() => {
    if (projectId === null || projectInDefault !== false) {
      setStored(null);
      return;
    }
    let stopped = false;
    let inFlight = false;
    setStored((current) =>
      current?.id === projectId
        ? current
        : {
            id: projectId,
            project: null,
            error: null,
            orbs: { items: null, error: null },
          },
    );
    const poll = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      const started = mutationRevision.current;
      const project = await getProject(projectId);
      if (stopped || started !== mutationRevision.current) {
        inFlight = false;
        return;
      }
      if (project.isErr()) {
        setStored((current) =>
          current?.id === projectId
            ? {
                ...current,
                project:
                  project.error.type === "http" && project.error.status === 404
                    ? null
                    : current.project,
                error: project.error,
              }
            : current,
        );
        inFlight = false;
        return;
      }
      setStored((current) =>
        current?.id === projectId ? { ...current, project: project.value, error: null } : current,
      );
      const orbs = await listOrbs(projectId);
      if (stopped || started !== mutationRevision.current) {
        inFlight = false;
        return;
      }
      setStored((current) =>
        current?.id === projectId
          ? {
              ...current,
              orbs: orbs.isOk()
                ? { items: orbs.value.items, error: null }
                : { items: current.orbs.items, error: orbs.error },
            }
          : current,
      );
      inFlight = false;
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [mutationRevision, projectId, projectInDefault]);

  const replaceProject = useCallback((project: ProjectView) => {
    setStored((current) =>
      current?.id === project.id ? { ...current, project, error: null } : current,
    );
  }, []);
  const upsertOrb = useCallback((orb: OrbView) => {
    setStored((current) =>
      current?.id === orb.projectId
        ? {
            ...current,
            orbs: {
              items: [...(current.orbs.items ?? []).filter((entry) => entry.id !== orb.id), orb],
              error: current.orbs.error,
            },
          }
        : current,
    );
  }, []);

  return { snapshot, replaceProject, upsertOrb };
}

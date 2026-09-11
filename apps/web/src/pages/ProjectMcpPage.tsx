import type { ProjectView } from "@pi-orb/protocol";
import { useEffect, useState } from "react";
import { ProjectConfigModal } from "../components/ProjectConfigModal.tsx";
import { describeApiError, getProject } from "../lib/api.ts";

/** Stable return/setup URL: credentials and OAuth callback parameters never reach this page. */
export function ProjectMcpPage({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<ProjectView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void getProject(projectId).then((r) => {
      if (!active) return;
      if (r.isOk()) setProject(r.value);
      else setError(describeApiError(r.error));
    });
    return () => {
      active = false;
    };
  }, [projectId]);
  return (
    <main>
      <a href="#/">Dashboard</a>
      {error && <p role="alert">{error}</p>}
      {project && (
        <ProjectConfigModal
          project={project}
          initialTabIndex={1}
          onChanged={setProject}
          onClose={() => {
            window.location.hash = `/projects/${projectId}`;
          }}
        />
      )}
    </main>
  );
}

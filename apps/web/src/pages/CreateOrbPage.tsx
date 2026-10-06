import { useEffect, useState } from "react";
import { type ApiError, createOrb, describeApiError, getProject } from "../lib/api.ts";
import { createOrbRequest } from "../lib/create-orb-request.ts";
import { navigate } from "../lib/navigation.ts";
import { generateUuid } from "../lib/uuid.ts";
import { NotFoundPage } from "./NotFoundPage.tsx";

interface CreateOrbPageProps {
  projectId: string;
}

type CreationState =
  | { type: "creating"; attempt: number }
  | { type: "failed"; attempt: number; error: ApiError };

export function CreateOrbPage({ projectId }: CreateOrbPageProps) {
  const [projectReady, setProjectReady] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [projectError, setProjectError] = useState<ApiError | null>(null);
  const [projectAttempt, setProjectAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry explicitly starts another addressed-project read.
  useEffect(() => {
    let active = true;
    void getProject(projectId).then((result) => {
      if (!active) return;
      setProjectReady(result.isOk() && result.value.state !== "deleting");
      setDeleting(result.isOk() && result.value.state === "deleting");
      setProjectError(result.isErr() ? result.error : null);
    });
    return () => {
      active = false;
    };
  }, [projectId, projectAttempt]);
  const [request] = useState(() =>
    createOrbRequest(
      generateUuid(),
      typeof window !== "undefined" &&
        new URLSearchParams(window.location.search).get("harness") === "claude"
        ? "claude"
        : "pi",
    ),
  );
  const [state, setState] = useState<CreationState>({ type: "creating", attempt: 0 });

  useEffect(() => {
    if (!projectReady || state.type !== "creating") return;
    let active = true;
    const source = window.location.href;
    const changedRoute = () => {
      active = false;
    };
    window.addEventListener("popstate", changedRoute);
    window.addEventListener("pi-orb:navigate", changedRoute);
    void createOrb(projectId, request).then((result) => {
      if (!active) return;
      if (result.isErr()) {
        setState({ type: "failed", attempt: state.attempt, error: result.error });
        return;
      }
      if (window.location.href === source)
        navigate(`/orbs/${encodeURIComponent(result.value.id)}`, true);
    });
    return () => {
      active = false;
      window.removeEventListener("popstate", changedRoute);
      window.removeEventListener("pi-orb:navigate", changedRoute);
    };
  }, [projectId, projectReady, request, state]);

  if (
    (projectError?.type === "http" && projectError.status === 404) ||
    (state.type === "failed" && state.error.type === "http" && state.error.status === 404)
  )
    return <NotFoundPage resourceName="Project" />;

  return (
    <main className="page simple-page">
      {deleting ? (
        <p className="muted">
          Project is being deleted. <a href="/">Back to dashboard</a>
        </p>
      ) : projectError !== null ? (
        <div className="banner banner-error" role="alert">
          {describeApiError(projectError)}{" "}
          <button type="button" onClick={() => setProjectAttempt(projectAttempt + 1)}>
            Retry
          </button>
        </div>
      ) : state.type === "creating" ? (
        <p className="muted" role="status">
          creating orb…
        </p>
      ) : (
        <>
          <p className="error-text" role="alert">
            failed to create orb: {describeApiError(state.error)}
          </p>
          <div className="create-orb-error-actions">
            <button
              type="button"
              onClick={() => setState({ type: "creating", attempt: state.attempt + 1 })}
            >
              retry
            </button>
            <a href="/">Back to dashboard</a>
          </div>
        </>
      )}
    </main>
  );
}

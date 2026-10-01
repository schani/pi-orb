import { useEffect, useState } from "react";
import { type ApiError, createOrb, describeApiError } from "../lib/api.ts";
import { createOrbRequest } from "../lib/create-orb-request.ts";
import { generateUuid } from "../lib/uuid.ts";
import { NotFoundPage } from "./NotFoundPage.tsx";

interface CreateOrbPageProps {
  projectId: string;
}

type CreationState =
  | { type: "creating"; attempt: number }
  | { type: "failed"; attempt: number; error: ApiError };

export function CreateOrbPage({ projectId }: CreateOrbPageProps) {
  const [request] = useState(() => createOrbRequest(generateUuid()));
  const [state, setState] = useState<CreationState>({ type: "creating", attempt: 0 });

  useEffect(() => {
    if (state.type !== "creating") return;
    let active = true;

    void createOrb(projectId, request).then((result) => {
      if (!active) return;
      if (result.isErr()) {
        setState({ type: "failed", attempt: state.attempt, error: result.error });
        return;
      }
      window.location.replace(`#/orbs/${result.value.id}`);
    });

    return () => {
      active = false;
    };
  }, [projectId, request, state]);

  if (state.type === "failed" && state.error.type === "http" && state.error.status === 404) {
    return <NotFoundPage resourceName="Project" />;
  }

  return (
    <main className="page simple-page">
      {state.type === "creating" ? (
        <p className="muted">creating orb…</p>
      ) : (
        <>
          <p className="error-text">failed to create orb: {describeApiError(state.error)}</p>
          <div className="create-orb-error-actions">
            <button
              type="button"
              onClick={() => setState({ type: "creating", attempt: state.attempt + 1 })}
            >
              retry
            </button>
            <a href="#/">Back to dashboard</a>
          </div>
        </>
      )}
    </main>
  );
}

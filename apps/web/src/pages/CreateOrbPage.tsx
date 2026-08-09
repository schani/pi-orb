import { useEffect, useState } from "react";
import { type ApiError, createOrb, describeApiError } from "../lib/api.ts";
import { generateUuid } from "../lib/uuid.ts";
import { NotFoundPage } from "./NotFoundPage.tsx";

interface CreateOrbPageProps {
  projectId: string;
}

type CreationState =
  | { type: "creating"; attempt: number }
  | { type: "failed"; attempt: number; error: ApiError };

export function CreateOrbPage({ projectId }: CreateOrbPageProps) {
  const [orbId] = useState(generateUuid);
  const [state, setState] = useState<CreationState>({ type: "creating", attempt: 0 });

  useEffect(() => {
    if (state.type !== "creating") return;
    let active = true;

    void createOrb(projectId, { id: orbId }).then((result) => {
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
  }, [orbId, projectId, state]);

  if (state.type === "failed" && state.error.type === "http" && state.error.status === 404) {
    return <NotFoundPage resourceName="Project" />;
  }

  return (
    <>
      <header className="app-header">
        <a href="#/" className="app-title">
          pi-orb
        </a>
      </header>
      <main className="app-main page create-orb-page">
        <h1>New Orb</h1>
        {state.type === "creating" ? (
          <p className="muted">creating orb…</p>
        ) : (
          <div className="banner banner-error">
            <p>failed to create orb: {describeApiError(state.error)}</p>
            <div className="create-orb-error-actions">
              <button
                type="button"
                onClick={() => setState({ type: "creating", attempt: state.attempt + 1 })}
              >
                retry
              </button>
              <a href="#/">Go to dashboard</a>
            </div>
          </div>
        )}
      </main>
    </>
  );
}

import { type ProjectInstructions, validateProjectInstructions } from "@pi-orb/protocol";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { describeApiError, getProjectInstructions, saveProjectInstructions } from "../lib/api.ts";

export interface ProjectInstructionsDraft {
  snapshot: ProjectInstructions | null;
  content: string;
}
/** The project gear owns this memory-only draft across dialog mounts. */
export function ProjectInstructionsEditor({
  projectId,
  active,
  saving,
  setSaving,
  retained,
}: {
  projectId: string;
  active: boolean;
  saving: boolean;
  setSaving: (saving: boolean) => void;
  retained: RefObject<ProjectInstructionsDraft | null>;
}) {
  const [document, setDocument] = useState<ProjectInstructionsDraft>(
    () => retained.current ?? { snapshot: null, content: "" },
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const epoch = useRef(0);
  const requested = useRef(false);
  const writePending = useRef(false);
  const dirty = document.snapshot !== null && document.content !== document.snapshot.content;
  const awaitingLoad = active && !requested.current && !dirty;
  const validation = validateProjectInstructions({ content: document.content });
  const remember = useCallback(
    (next: ProjectInstructionsDraft) => {
      retained.current = next;
      setDocument(next);
    },
    [retained],
  );
  useEffect(
    () => () => {
      epoch.current++;
      requested.current = false;
    },
    [],
  );
  const load = useCallback(async () => {
    const request = ++epoch.current;
    setLoading(true);
    setError(null);
    setSaved(false);
    const result = await getProjectInstructions(projectId);
    if (epoch.current !== request) return;
    setLoading(false);
    if (result.isErr()) {
      setError(describeApiError(result.error));
      remember({ snapshot: null, content: retained.current?.content ?? "" });
      return;
    }
    remember({ snapshot: result.value, content: result.value.content });
  }, [projectId, remember, retained]);
  useEffect(() => {
    if (!active || requested.current) return;
    requested.current = true;
    const previous = retained.current;
    if (previous?.snapshot && previous.content !== previous.snapshot.content) return;
    void load();
  }, [active, load, retained]);
  const save = async () => {
    if (writePending.current || saving || loading || awaitingLoad || !dirty || validation.isErr())
      return;
    writePending.current = true;
    const request = ++epoch.current;
    setSaving(true);
    setError(null);
    setSaved(false);
    const result = await saveProjectInstructions(projectId, document.content);
    if (epoch.current !== request) return;
    writePending.current = false;
    setSaving(false);
    if (result.isErr()) {
      setError(describeApiError(result.error));
      return;
    }
    remember({ snapshot: result.value, content: result.value.content });
    setSaved(true);
  };
  return (
    <form
      className="project-instructions-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <textarea
        aria-label="Additional project instructions"
        spellCheck={false}
        autoComplete="off"
        value={document.content}
        disabled={loading || awaitingLoad || saving || document.snapshot === null}
        onChange={(event) => {
          remember({ ...document, content: event.target.value });
          setSaved(false);
          setError(null);
        }}
      />
      <div className="personal-instructions-feedback">
        {error !== null ? (
          <span role="alert" className="personal-instructions-error">
            {error}
          </span>
        ) : validation.isErr() && document.snapshot !== null ? (
          <span role="alert" className="personal-instructions-error">
            {validation.error.message}
          </span>
        ) : (
          <span role="status">
            {loading || awaitingLoad
              ? "Loading…"
              : saving
                ? "Saving…"
                : saved
                  ? "Saved · next orb start"
                  : dirty
                    ? "Unsaved"
                    : ""}
          </span>
        )}
        {document.snapshot === null && !loading && !awaitingLoad && (
          <button type="button" onClick={() => void load()}>
            Retry
          </button>
        )}
        <button
          type="submit"
          disabled={loading || awaitingLoad || saving || !dirty || validation.isErr()}
        >
          Save
        </button>
      </div>
    </form>
  );
}

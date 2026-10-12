import { type GitIdentity, validateGitIdentity } from "@pi-orb/protocol";
import { type RefObject, useEffect, useRef, useState } from "react";
import { describeApiError, getGitIdentity, saveGitIdentity } from "../lib/api.ts";
import { TextFieldFrame } from "./TextFieldFrame.tsx";

/** Owned by the always-mounted Settings button so drafts survive close/reopen. */
export function useGitIdentity(dialog: RefObject<HTMLElement | null>) {
  const [snapshot, setSnapshot] = useState<GitIdentity | null>(null);
  const [draft, setDraft] = useState<GitIdentity>({ name: "", email: "" });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const epoch = useRef(0);
  const writePending = useRef(false);
  useEffect(
    () => () => {
      epoch.current++;
    },
    [],
  );
  const dirty =
    snapshot !== null && (draft.name !== snapshot.name || draft.email !== snapshot.email);
  const validation = validateGitIdentity(draft);

  const load = async () => {
    const request = ++epoch.current;
    setLoading(true);
    setError(null);
    setSaved(false);
    const result = await getGitIdentity();
    if (epoch.current !== request) return;
    setLoading(false);
    if (result.isErr()) {
      setError(describeApiError(result.error));
      setSnapshot(null);
      return;
    }
    setSnapshot(result.value);
    setDraft(result.value);
  };
  const cancel = () => {
    epoch.current++;
    setLoading(false);
  };
  const save = async () => {
    if (writePending.current || loading || !dirty || validation.isErr()) return;
    writePending.current = true;
    const request = ++epoch.current;
    dialog.current?.focus();
    setSaving(true);
    setError(null);
    setSaved(false);
    const result = await saveGitIdentity(draft);
    if (epoch.current !== request) return;
    writePending.current = false;
    setSaving(false);
    if (result.isErr()) {
      setError(describeApiError(result.error));
      return;
    }
    setSnapshot(result.value);
    setDraft(result.value);
    setSaved(true);
  };
  const edit = (field: keyof GitIdentity, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setSaved(false);
    setError(null);
  };
  return {
    snapshot,
    draft,
    loading,
    saving,
    error,
    saved,
    dirty,
    validation,
    writePending,
    load,
    cancel,
    save,
    edit,
  };
}

export function GitIdentityPane({ git }: { git: ReturnType<typeof useGitIdentity> }) {
  const disabled = git.loading || git.saving || git.snapshot === null;
  return (
    <form
      autoComplete="off"
      data-1p-ignore="true"
      onSubmit={(event) => {
        event.preventDefault();
        void git.save();
      }}
    >
      <div className="project-secrets-body">
        <div className="project-secret-form project-general-form">
          {(["name", "email"] as const).map((field) => (
            <label key={field}>
              user.{field}
              <TextFieldFrame>
                <input
                  value={git.draft[field]}
                  spellCheck={false}
                  data-1p-ignore="true"
                  disabled={disabled}
                  onChange={(event) => git.edit(field, event.target.value)}
                />
              </TextFieldFrame>
            </label>
          ))}
        </div>
      </div>
      <div className="personal-instructions-feedback">
        {git.error !== null ? (
          <span role="alert" className="personal-instructions-error">
            {git.error}
          </span>
        ) : git.validation.isErr() && git.dirty ? (
          <span role="alert" className="personal-instructions-error">
            {git.validation.error.message}
          </span>
        ) : (
          <span role="status">
            {git.loading
              ? "Loading…"
              : git.saving
                ? "Saving…"
                : git.saved
                  ? "Saved · next orb start"
                  : git.dirty
                    ? "Unsaved"
                    : ""}
          </span>
        )}
        {git.snapshot === null && !git.loading && (
          <button type="button" onClick={() => void git.load()}>
            Retry
          </button>
        )}
        <button
          type="submit"
          disabled={git.loading || git.saving || !git.dirty || git.validation.isErr()}
        >
          Save
        </button>
      </div>
    </form>
  );
}

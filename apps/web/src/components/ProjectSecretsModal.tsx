import {
  PROJECT_SECRET_MAX_VALUE_BYTES,
  PROJECT_SECRET_NAME_PATTERN,
  type ProjectSecretList,
  type ProjectView,
} from "@pi-orb/protocol";
import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  deleteProjectSecret,
  describeApiError,
  listProjectSecrets,
  putProjectSecret,
} from "../lib/api.ts";
import { ProjectSecretKeyIcon } from "./ProjectSecretKeyIcon.tsx";

export interface ProjectSecretsModalProps {
  readonly project: ProjectView;
  readonly onCountChange?: (projectId: string, count: number) => void;
  readonly onClose: () => void;
}

const EMPTY: ProjectSecretList = { revision: 0, items: [] };

export function ProjectSecretsModal({ project, onCountChange, onClose }: ProjectSecretsModalProps) {
  const [snapshot, setSnapshot] = useState<ProjectSecretList>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const valueInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    void listProjectSecrets(project.id).then((result) => {
      if (!active) return;
      setLoading(false);
      if (result.isErr()) setError(describeApiError(result.error));
      else {
        setSnapshot(result.value);
        onCountChange?.(project.id, result.value.items.length);
      }
    });
    return () => {
      active = false;
    };
  }, [onCountChange, project.id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || saving) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    nameInput.current?.focus();
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const secretName = name.trim();
    if (!new RegExp(PROJECT_SECRET_NAME_PATTERN).test(secretName)) {
      setError("Use a POSIX environment name such as NPM_TOKEN.");
      return;
    }
    if (value === "") {
      setError("Enter a secret value.");
      return;
    }
    setSaving(true);
    setError(null);
    const result = await putProjectSecret(project.id, secretName, value);
    setSaving(false);
    if (result.isErr()) {
      // Deliberately preserve both fields: a network failure must not destroy
      // the only copy of a write-only value the user was trying to save.
      setError(describeApiError(result.error));
      return;
    }
    setSnapshot(result.value);
    onCountChange?.(project.id, result.value.items.length);
    setName("");
    setValue("");
    nameInput.current?.focus();
  };

  const remove = async (secretName: string) => {
    if (!window.confirm(`Remove ${secretName} from every ${project.name} orb on its next start?`)) {
      return;
    }
    setSaving(true);
    setError(null);
    const result = await deleteProjectSecret(project.id, secretName);
    setSaving(false);
    if (result.isErr()) setError(describeApiError(result.error));
    else {
      setSnapshot(result.value);
      onCountChange?.(project.id, result.value.items.length);
    }
  };

  return (
    <div className="project-secrets-backdrop">
      <section
        className="project-secrets-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-secrets-title"
      >
        <header className="project-secrets-header">
          <span className="project-secrets-lock">
            <ProjectSecretKeyIcon />
          </span>
          <div>
            <h2 id="project-secrets-title">Secrets for {project.name}</h2>
            <p>Shared by every orb · values apply on next start</p>
          </div>
          <button
            type="button"
            className="project-secrets-close"
            aria-label="Close project secrets"
            disabled={saving}
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="project-secrets-body">
          {loading ? (
            <p className="muted">loading…</p>
          ) : (
            <div className="project-secrets-list">
              {snapshot.items.map((item) => (
                <div className="project-secret-row" key={item.name}>
                  <span className="project-secret-name">
                    <span className="project-secrets-lock">
                      <ProjectSecretKeyIcon />
                    </span>
                    {item.name}
                  </span>
                  <span className="project-secret-updated">
                    updated {new Date(item.updatedAt).toLocaleDateString()}
                  </span>
                  <span className="project-secret-actions">
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => {
                        setName(item.name);
                        setValue("");
                        setError(null);
                        queueMicrotask(() => valueInput.current?.focus());
                      }}
                    >
                      replace
                    </button>
                    <button type="button" disabled={saving} onClick={() => void remove(item.name)}>
                      remove
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
          <form className="project-secret-form" onSubmit={(event) => void save(event)}>
            <label>
              name
              <input
                ref={nameInput}
                value={name}
                autoComplete="off"
                placeholder="NPM_TOKEN"
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label>
              secret value
              <input
                ref={valueInput}
                type="password"
                value={value}
                maxLength={PROJECT_SECRET_MAX_VALUE_BYTES}
                autoComplete="new-password"
                placeholder="value is never shown again"
                onChange={(event) => setValue(event.target.value)}
              />
            </label>
            <button type="submit" disabled={saving}>
              {saving ? "saving…" : "save secret"}
            </button>
          </form>
          {error !== null && <div className="banner banner-error">{error}</div>}
        </div>
      </section>
    </div>
  );
}

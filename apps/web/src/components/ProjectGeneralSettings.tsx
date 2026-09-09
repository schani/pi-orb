import { PROJECT_NAME_MAX_CHARS, type ProjectView, validateRepositoryUrl } from "@pi-orb/protocol";
import { useEffect, useRef, useState } from "react";
import { describeApiError, updateProject } from "../lib/api.ts";

export function ProjectGeneralSettings({
  project,
  saving,
  setSaving,
  onChanged,
}: {
  project: ProjectView;
  saving: boolean;
  setSaving: (saving: boolean) => void;
  onChanged: (project: ProjectView) => void | Promise<void>;
}) {
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const [name, setName] = useState(project.name);
  const [repositoryUrl, setRepositoryUrl] = useState(project.repositoryUrl);
  const [error, setError] = useState<string | null>(null);
  const repository = validateRepositoryUrl(repositoryUrl.trim());
  const valid = name.trim().length > 0 && repository.isOk();
  const save = async () => {
    if (saving || !valid || repository.isErr()) return;
    setSaving(true);
    setError(null);
    const result = await updateProject(project.id, {
      name: name.trim(),
      repositoryUrl: repository.value.url,
    });
    if (!active.current) return;
    setSaving(false);
    if (result.isErr()) {
      setError(describeApiError(result.error));
      return;
    }
    setName(result.value.name);
    setRepositoryUrl(result.value.repositoryUrl);
    await onChanged(result.value);
  };
  return (
    <div className="project-secrets-body">
      <form
        className="project-secret-form project-general-form"
        autoComplete="off"
        data-1p-ignore="true"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label>
          Name
          <input
            value={name}
            maxLength={PROJECT_NAME_MAX_CHARS}
            disabled={saving}
            required
            data-1p-ignore="true"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          Repository URL
          <input
            value={repositoryUrl}
            disabled={saving}
            required
            aria-invalid={repository.isErr()}
            aria-describedby={repository.isErr() ? "project-repository-error" : undefined}
            onChange={(event) => setRepositoryUrl(event.target.value)}
          />
        </label>
        {repository.isErr() && (
          <p id="project-repository-error" role="alert" className="banner banner-error">
            {repository.error.message}
          </p>
        )}
        <button type="submit" disabled={saving || !valid}>
          {saving ? "saving…" : "save"}
        </button>
      </form>
      {error !== null && (
        <p role="alert" className="banner banner-error">
          {error}
        </p>
      )}
    </div>
  );
}

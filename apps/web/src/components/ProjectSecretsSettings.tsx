import {
  type McpCatalog,
  mcpSecretUsers,
  PROJECT_SECRET_MAX_VALUE_BYTES,
  PROJECT_SECRET_NAME_PATTERN,
  type ProjectSecretList,
  type ProjectView,
} from "@pi-orb/protocol";
import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  deleteProjectSecret,
  describeApiError,
  getProjectMcp,
  listProjectSecrets,
  putProjectSecret,
} from "../lib/api.ts";
import { ProjectSecretKeyIcon } from "./ProjectSecretKeyIcon.tsx";

export interface ProjectSecretsSettingsProps {
  readonly project: Pick<ProjectView, "id" | "name">;
  readonly saving: boolean;
  readonly active?: boolean;
  readonly setSaving: (saving: boolean) => void;
}

const EMPTY: ProjectSecretList = { revision: 0, items: [] };

export function ProjectSecretsSettings({
  project,
  saving,
  setSaving,
  active = true,
}: ProjectSecretsSettingsProps) {
  const [snapshot, setSnapshot] = useState<ProjectSecretList>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [mcp, setMcp] = useState<McpCatalog | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    let current = true;
    let request = 0;
    const refresh = () => {
      const revision = ++request;
      void getProjectMcp(project.id).then((result) => {
        if (!current || revision !== request) return;
        if (result.isOk()) {
          setMcp(result.value);
          setUsageError(null);
        } else {
          setMcp(null);
          setUsageError(describeApiError(result.error));
        }
      });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      current = false;
      window.removeEventListener("focus", refresh);
    };
  }, [active, project.id]);
  const nameInput = useRef<HTMLInputElement>(null);
  const valueInput = useRef<HTMLInputElement>(null);
  const focusAfterSave = useRef(false);
  useEffect(() => {
    if (!saving && focusAfterSave.current) {
      focusAfterSave.current = false;
      nameInput.current?.focus();
    }
  }, [saving]);

  useEffect(() => {
    let active = true;
    void listProjectSecrets(project.id).then((result) => {
      if (!active) return;
      setLoading(false);
      if (result.isErr()) setError(describeApiError(result.error));
      else setSnapshot(result.value);
    });
    return () => {
      active = false;
    };
  }, [project.id]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || loading) return;
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
    setName("");
    setValue("");
    focusAfterSave.current = true;
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
    else setSnapshot(result.value);
  };

  return (
    <div className="project-secrets-body">
      {loading ? (
        <p className="muted">loading…</p>
      ) : (
        <div className="project-secrets-list">
          {snapshot.items.map((item) => {
            const users = mcpSecretUsers(mcp?.servers ?? [], item.name);
            return (
              <div className="project-secret-row" key={item.name}>
                <span className="project-secret-name">
                  <span className="project-secrets-lock">
                    <ProjectSecretKeyIcon />
                  </span>
                  {item.name}
                </span>
                <span className="project-secret-updated">
                  {users.length
                    ? `used by ${users.join(", ")}`
                    : `updated ${new Date(item.updatedAt).toLocaleDateString()}`}
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
                  <button
                    type="button"
                    disabled={saving || mcp === null || users.length > 0}
                    onClick={() => void remove(item.name)}
                  >
                    remove
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}
      <form className="project-secret-form" onSubmit={(event) => void save(event)}>
        <label>
          name
          <input
            ref={nameInput}
            disabled={saving}
            data-1p-ignore="true"
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
            disabled={saving}
            type="password"
            value={value}
            maxLength={PROJECT_SECRET_MAX_VALUE_BYTES}
            autoComplete="new-password"
            placeholder="value is never shown again"
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        <button type="submit" disabled={saving || loading}>
          {saving ? "saving…" : "save secret"}
        </button>
      </form>
      {usageError && (
        <div className="banner banner-error" role="alert">
          Cannot check MCP usage. {usageError}
        </div>
      )}
      {error !== null && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

import type { OwnerSkillList, OwnerSkillPreview, OwnerSkillSourceMetadata } from "@pi-orb/protocol";
import type { Result } from "neverthrow";
import { type RefObject, useEffect, useRef, useState } from "react";
import {
  type ApiError,
  deleteOwnerSkill,
  describeApiError,
  importOwnerSkill,
  listOwnerSkills,
  previewOwnerSkill,
  saveOwnerSkill,
} from "../lib/api.ts";
import { TextFieldFrame } from "./TextFieldFrame.tsx";

/** Draft and focus keys are never valid skill names. */
const NEW = "+new";

/** Owned by the always-mounted Settings button so drafts survive close/reopen. */
export function useOwnerSkills(dialog: RefObject<HTMLElement | null>) {
  const [items, setItems] = useState<OwnerSkillList["items"] | null>(null);
  const [drafts, setDrafts] = useState<Readonly<Record<string, string | undefined>>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The last write's outcome, shown only in its row: `error: null` is the save receipt. */
  const [status, setStatus] = useState<{ key: string; error: string | null } | null>(null);
  const epoch = useRef(0);
  const writing = useRef(false);
  const [source, setSource] = useState<"manual" | "github">("manual");
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<OwnerSkillPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const previewRequest = useRef<{ epoch: number; controller?: AbortController }>({ epoch: 0 });
  useEffect(() => () => previewRequest.current.controller?.abort(), []);

  const cancelPreview = () => {
    previewRequest.current.controller?.abort();
    previewRequest.current = { epoch: previewRequest.current.epoch + 1 };
    setPreviewing(false);
  };
  const changeSource = (next: "manual" | "github") => {
    cancelPreview();
    setSource(next);
  };
  const changeUrl = (next: string) => {
    cancelPreview();
    setUrl(next);
    setPreview(null);
    setImportError(null);
  };
  const review = async () => {
    if (writing.current || previewing || !url.trim()) return;
    cancelPreview();
    const controller = new AbortController();
    const request = ++previewRequest.current.epoch;
    previewRequest.current.controller = controller;
    setPreviewing(true);
    setImportError(null);
    setPreview(null);
    const result = await previewOwnerSkill(url.trim(), controller.signal);
    if (request !== previewRequest.current.epoch) return;
    setPreviewing(false);
    if (result.isErr()) setImportError(describeApiError(result.error));
    else setPreview(result.value);
  };

  const load = async () => {
    if (writing.current) return;
    const request = ++epoch.current;
    setError(null);
    const result = await listOwnerSkills();
    if (epoch.current !== request) return;
    if (result.isErr()) setError(describeApiError(result.error));
    else setItems(result.value.items);
  };
  const setDraft = (key: string, content?: string) => {
    setDrafts((current) => ({ ...current, [key]: content }));
    setStatus(null);
  };
  const write = async (
    key: string,
    request: () => Promise<Result<OwnerSkillList, ApiError>>,
    reportError?: (error: string) => void,
  ) => {
    if (writing.current) return null;
    writing.current = true;
    epoch.current++; // supersedes an in-flight list
    dialog.current?.focus();
    setSaving(true);
    if (!reportError) setStatus(null);
    const result = await request();
    writing.current = false;
    setSaving(false);
    if (result.isErr()) {
      const error = describeApiError(result.error);
      if (reportError) reportError(error);
      else setStatus({ key, error });
    } else setItems(result.value.items);
    return result.isOk() ? result.value.items : null;
  };
  const save = async (key: string) => {
    const content = drafts[key];
    if (saving || items === null || content === undefined) return;
    const after = await write(key, () => saveOwnerSkill(key === NEW ? null : key, content));
    if (after === null) return;
    // A create or rename is the one name the returned list adds.
    const name = after.find((skill) => !items.some((old) => old.name === skill.name))?.name ?? key;
    if (key === NEW) cancel();
    else setDraft(key);
    setOpen(name);
    setStatus({ key: name, error: null });
  };
  const remove = async (name: string) => {
    if (saving || !window.confirm(`Remove ${name} from every orb on its next start?`)) return;
    if ((await write(name, () => deleteOwnerSkill(name))) !== null) setDraft(name);
  };
  const cancel = () => {
    cancelPreview();
    setDraft(NEW);
    setSource("manual");
    setUrl("");
    setPreview(null);
    setImportError(null);
  };
  const addImport = async () => {
    if (writing.current || preview === null || source !== "github") return;
    const pinned = preview;
    setImportError(null);
    const after = await write(
      NEW,
      () => importOwnerSkill(pinned.source.url, pinned.source.commitSha),
      setImportError,
    );
    if (after === null) return;
    cancel();
    setOpen(pinned.name);
    setStatus({ key: pinned.name, error: null });
  };
  return {
    items,
    drafts,
    open,
    setOpen,
    saving,
    error,
    status,
    load,
    setDraft,
    save,
    remove,
    source,
    changeSource,
    url,
    changeUrl,
    preview,
    previewing,
    importError,
    review,
    addImport,
    cancel,
  };
}
export type OwnerSkills = ReturnType<typeof useOwnerSkills>;

export function OwnerSkillsPane({ skills }: { skills: OwnerSkills }) {
  const focus = useRef<string | null>(null);
  const focusOnMount = (target: string) => (element: HTMLElement | null) => {
    if (element === null || focus.current !== target) return;
    focus.current = null;
    element.focus();
  };
  const adding = skills.drafts[NEW] !== undefined;
  const rows = [
    ...(skills.items ?? []),
    ...(adding
      ? [
          {
            name: NEW,
            description: "",
            content: "",
            source: null,
            fileCount: 1,
            totalBytes: 0,
            updatedAt: "",
          },
        ]
      : []),
  ];
  return (
    <div className="project-secrets-body">
      {skills.items === null && skills.error === null && <span className="muted">loading…</span>}
      {rows.map(({ name, description, content, source, fileCount, totalBytes }) => {
        const draft = skills.drafts[name] ?? content;
        const status = skills.status?.key === name ? skills.status : null;
        return (
          <details
            key={name}
            className="activity-rail-row project-mcp-connection"
            open={skills.open === name}
            onToggle={(event) => {
              const opened = event.currentTarget.open;
              skills.setOpen((current) => (opened ? name : current === name ? null : current));
            }}
          >
            <summary>
              <span className="activity-rail-marker" aria-hidden="true" />
              <span className="activity-rail-summary">
                {name === NEW ? "new skill" : name}
                {name !== NEW && <span className="activity-rail-headline"> · {description}</span>}
              </span>
            </summary>
            <div className="reasoning-body">
              {name === NEW && (
                <label className="skill-source-picker">
                  Source
                  <select
                    aria-label="Draft source"
                    value={skills.source}
                    disabled={skills.saving}
                    onChange={(event) =>
                      skills.changeSource(event.target.value === "github" ? "github" : "manual")
                    }
                  >
                    <option value="manual">SKILL.md</option>
                    <option value="github">GitHub URL</option>
                  </select>
                </label>
              )}
              {name !== NEW && (
                <>
                  {source !== null && <SkillSource source={source} label="Import origin" />}
                  <p className="skill-file-totals">{fileTotals(fileCount, totalBytes)}</p>
                </>
              )}
              {name === NEW && skills.source === "github" ? (
                <GitHubDraft
                  skills={skills}
                  cancel={() => {
                    focus.current = "+add";
                    skills.cancel();
                  }}
                />
              ) : (
                <form
                  className="project-instructions-editor skill-editor"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void skills.save(name);
                  }}
                >
                  <TextFieldFrame>
                    <textarea
                      ref={focusOnMount(name)}
                      aria-label="SKILL.md"
                      spellCheck={false}
                      autoComplete="off"
                      value={draft}
                      disabled={skills.saving}
                      onChange={(event) => skills.setDraft(name, event.target.value)}
                    />
                  </TextFieldFrame>
                  <div className="personal-instructions-feedback">
                    {status?.error ? (
                      <span role="alert" className="personal-instructions-error">
                        {status.error}
                      </span>
                    ) : (
                      <span role="status">
                        {status ? "Saved · next orb start" : draft !== content ? "Unsaved" : ""}
                      </span>
                    )}
                    {name === NEW ? (
                      <button
                        type="button"
                        disabled={skills.saving}
                        onClick={() => {
                          focus.current = "+add";
                          skills.cancel();
                        }}
                      >
                        cancel
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="danger"
                        disabled={skills.saving}
                        onClick={() => void skills.remove(name)}
                      >
                        remove
                      </button>
                    )}
                    <button type="submit" disabled={skills.saving || draft === content}>
                      Save
                    </button>
                  </div>
                </form>
              )}
            </div>
          </details>
        );
      })}
      {skills.items !== null && !adding && (
        <div className="mcp-add-area">
          <button
            ref={focusOnMount("+add")}
            type="button"
            className="text-action"
            disabled={skills.saving}
            onClick={() => {
              focus.current = NEW;
              skills.setDraft(NEW, "");
              skills.setOpen(NEW);
            }}
          >
            add skill
          </button>
        </div>
      )}
      {skills.error !== null && (
        <p className="banner banner-error" role="alert">
          {skills.error}{" "}
          <button type="button" onClick={() => void skills.load()}>
            Retry
          </button>
        </p>
      )}
    </div>
  );
}

function fileTotals(count: number, bytes: number) {
  return `${count} ${count === 1 ? "file" : "files"} · ${bytes} bytes`;
}

function SkillSource({ source, label }: { source: OwnerSkillSourceMetadata; label: string }) {
  return (
    <dl className="skill-import-source">
      <dt>{label}</dt>
      <dd>{source.url}</dd>
      <dt>Commit</dt>
      <dd>{source.commitSha}</dd>
    </dl>
  );
}

function GitHubDraft({ skills, cancel }: { skills: OwnerSkills; cancel: () => void }) {
  const preview = skills.preview;
  const error = skills.importError;
  return (
    <div className="skill-github-draft">
      <form
        className="skill-url-form"
        onSubmit={(event) => {
          event.preventDefault();
          void skills.review();
        }}
      >
        <TextFieldFrame>
          <input
            aria-label="GitHub URL"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={skills.url}
            disabled={skills.saving}
            onChange={(event) => skills.changeUrl(event.target.value)}
          />
        </TextFieldFrame>
        <button type="submit" disabled={skills.saving || skills.previewing || !skills.url.trim()}>
          Preview
        </button>
      </form>
      {skills.previewing && <span role="status">Previewing…</span>}
      {preview !== null && (
        <div className="skill-import-review">
          <h3>{preview.name}</h3>
          <p>{preview.description}</p>
          <SkillSource source={preview.source} label="Source" />
          <details className="skill-file-preview">
            <summary>{fileTotals(preview.fileCount, preview.totalBytes)}</summary>
            <pre>
              {preview.manifest
                .map(
                  (file) =>
                    `${file.path} · ${file.bytes} bytes${file.executable ? " · executable" : ""}`,
                )
                .join("\n")}
            </pre>
          </details>
          <details className="skill-content-preview">
            <summary>SKILL.md</summary>
            <pre>{preview.content}</pre>
          </details>
        </div>
      )}
      {error !== null && (
        <span role="alert" className="personal-instructions-error">
          {error}
        </span>
      )}
      <div className="personal-instructions-feedback">
        <span />
        <button type="button" disabled={skills.saving} onClick={cancel}>
          cancel
        </button>
        {preview !== null && (
          <button
            type="button"
            disabled={skills.saving || skills.previewing}
            onClick={() => void skills.addImport()}
          >
            Add
          </button>
        )}
      </div>
    </div>
  );
}

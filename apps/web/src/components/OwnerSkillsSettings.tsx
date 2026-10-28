import type { OwnerSkillList } from "@pi-orb/protocol";
import type { Result } from "neverthrow";
import { type RefObject, useRef, useState } from "react";
import {
  type ApiError,
  deleteOwnerSkill,
  describeApiError,
  importOwnerSkill,
  listOwnerSkills,
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
  const [newSource, setNewSource] = useState("manual");
  const [githubUrl, setGithubUrl] = useState("");
  const writing = useRef(false);
  const [error, setError] = useState<string | null>(null);
  /** The last write's outcome, shown only in its row: `error: null` is the save receipt. */
  const [status, setStatus] = useState<{ key: string; error: string | null } | null>(null);
  const epoch = useRef(0);

  const load = async () => {
    const request = ++epoch.current;
    setError(null);
    setStatus(null);
    const result = await listOwnerSkills();
    if (epoch.current !== request) return;
    if (result.isErr()) setError(describeApiError(result.error));
    else setItems(result.value.items);
  };
  const setDraft = (key: string, content?: string) => {
    setDrafts((current) => ({ ...current, [key]: content }));
    if (key === NEW && content === undefined) {
      setNewSource("manual");
      setGithubUrl("");
    }
    setStatus(null);
  };
  const write = async (key: string, request: () => Promise<Result<OwnerSkillList, ApiError>>) => {
    if (writing.current) return null;
    writing.current = true;
    epoch.current++; // supersedes an in-flight list
    dialog.current?.focus();
    setSaving(true);
    setStatus(null);
    const result = await request();
    writing.current = false;
    setSaving(false);
    if (result.isErr()) setStatus({ key, error: describeApiError(result.error) });
    else setItems(result.value.items);
    return result.isOk() ? result.value.items : null;
  };
  const save = async (key: string) => {
    const content = drafts[key];
    if (saving || items === null || content === undefined) return;
    const after = await write(key, () =>
      key === NEW && newSource === "github"
        ? importOwnerSkill(githubUrl)
        : saveOwnerSkill(key === NEW ? null : key, content),
    );
    if (after === null) return;
    // A create or rename is the one name the returned list adds.
    const name = after.find((skill) => !items.some((old) => old.name === skill.name))?.name ?? key;
    setDraft(key);
    setOpen(name);
    setStatus({ key: name, error: null });
  };
  const remove = async (name: string) => {
    if (saving || !window.confirm(`Remove ${name} from every orb on its next start?`)) return;
    if ((await write(name, () => deleteOwnerSkill(name))) !== null) setDraft(name);
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
    newSource,
    githubUrl,
    setNewSource: (source: string) => {
      setNewSource(source);
      setStatus(null);
    },
    setGithubUrl: (url: string) => {
      setGithubUrl(url);
      setStatus(null);
    },
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
    ...(adding ? [{ name: NEW, description: "", content: "", source: null }] : []),
  ];
  return (
    <div className="project-secrets-body">
      {skills.items === null && skills.error === null && <span className="muted">loading…</span>}
      {rows.map(({ name, description, content, source }) => {
        const draft = skills.drafts[name] ?? content;
        const status = skills.status?.key === name ? skills.status : null;
        const github = name === NEW && skills.newSource === "github";
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
              <form
                className="project-instructions-editor skill-editor"
                onSubmit={(event) => {
                  event.preventDefault();
                  void skills.save(name);
                }}
              >
                {source && (
                  <a className="skill-source" href={source.url} target="_blank" rel="noreferrer">
                    {source.url}
                  </a>
                )}
                {name === NEW && (
                  <select
                    aria-label="Source"
                    value={skills.newSource}
                    disabled={skills.saving}
                    onChange={(event) => skills.setNewSource(event.target.value)}
                  >
                    <option value="manual">SKILL.md</option>
                    <option value="github">GitHub URL</option>
                  </select>
                )}
                <TextFieldFrame>
                  {github ? (
                    <input
                      aria-label="GitHub URL"
                      type="url"
                      spellCheck={false}
                      autoComplete="off"
                      value={skills.githubUrl}
                      disabled={skills.saving}
                      onChange={(event) => skills.setGithubUrl(event.target.value)}
                    />
                  ) : (
                    <textarea
                      ref={focusOnMount(name)}
                      aria-label="SKILL.md"
                      spellCheck={false}
                      autoComplete="off"
                      value={draft}
                      disabled={skills.saving}
                      onChange={(event) => skills.setDraft(name, event.target.value)}
                    />
                  )}
                </TextFieldFrame>
                <div className="personal-instructions-feedback">
                  {status?.error ? (
                    <span role="alert" className="personal-instructions-error">
                      {status.error}
                    </span>
                  ) : (
                    <span role="status">
                      {status
                        ? "Saved · next orb start"
                        : (github ? skills.githubUrl !== "" : draft !== content)
                          ? "Unsaved"
                          : ""}
                    </span>
                  )}
                  {name === NEW ? (
                    <button
                      type="button"
                      disabled={skills.saving}
                      onClick={() => {
                        focus.current = "+add";
                        skills.setDraft(NEW);
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
                  <button
                    type="submit"
                    disabled={
                      skills.saving || (github ? !skills.githubUrl.trim() : draft === content)
                    }
                  >
                    {github ? "Add" : "Save"}
                  </button>
                </div>
              </form>
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

import type { OwnerSkill, OwnerSkillList } from "@pi-orb/protocol";
import type { Result } from "neverthrow";
import { type RefObject, useEffect, useId, useRef, useState } from "react";
import {
  type ApiError,
  createOwnerSkill,
  deleteOwnerSkill,
  describeApiError,
  listOwnerSkills,
  saveOwnerSkill,
} from "../lib/api.ts";
import { TextFieldFrame } from "./TextFieldFrame.tsx";

/** Draft key of the unsaved new skill; never a valid skill name. */
export const NEW_SKILL = "+new";

/** The server returns the whole list; a create or rename is the one name new to it. */
export function savedSkillName(
  before: readonly OwnerSkill[],
  after: readonly OwnerSkill[],
  edited: string,
): string {
  const known = new Set(before.map((skill) => skill.name));
  return after.find((skill) => !known.has(skill.name))?.name ?? edited;
}

/** Owned by the always-mounted Settings button so drafts survive close/reopen. */
export function useOwnerSkills(dialog: RefObject<HTMLElement | null>) {
  const [items, setItems] = useState<readonly OwnerSkill[] | null>(null);
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The last mutation's outcome, shown only in its row: `error: null` is the save receipt. */
  const [status, setStatus] = useState<{ key: string; error: string | null } | null>(null);
  const epoch = useRef(0);
  const writePending = useRef(false);
  useEffect(
    () => () => {
      epoch.current++;
    },
    [],
  );

  const load = async () => {
    const request = ++epoch.current;
    setLoading(true);
    setError(null);
    setStatus(null);
    const result = await listOwnerSkills();
    if (epoch.current !== request) return;
    setLoading(false);
    if (result.isErr()) setError(describeApiError(result.error));
    else setItems(result.value.items);
  };
  const cancel = () => {
    epoch.current++;
    setLoading(false);
  };
  const forget = (key: string) =>
    setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([k]) => k !== key)));
  const mutate = async (
    key: string,
    request: () => Promise<Result<OwnerSkillList, ApiError>>,
  ): Promise<OwnerSkillList | null> => {
    writePending.current = true;
    const owner = ++epoch.current;
    dialog.current?.focus();
    setSaving(true);
    setStatus(null);
    const result = await request();
    if (epoch.current !== owner) return null;
    writePending.current = false;
    setSaving(false);
    if (result.isErr()) {
      setStatus({ key, error: describeApiError(result.error) });
      return null;
    }
    setItems(result.value.items);
    return result.value;
  };
  const save = async (key: string) => {
    const content = drafts[key];
    if (writePending.current || loading || items === null || content === undefined) return;
    const before = items;
    const list = await mutate(key, () =>
      key === NEW_SKILL ? createOwnerSkill(content) : saveOwnerSkill(key, content),
    );
    if (list === null) return;
    const name = savedSkillName(before, list.items, key);
    forget(key);
    if (key === NEW_SKILL) setAdding(false);
    setOpen(name);
    setStatus({ key: name, error: null });
  };
  const remove = async (name: string): Promise<boolean> => {
    if (writePending.current || loading) return false;
    if (!window.confirm(`Remove ${name} from every orb on its next start?`)) return false;
    if ((await mutate(name, () => deleteOwnerSkill(name))) === null) return false;
    forget(name);
    setOpen(null);
    return true;
  };
  const edit = (key: string, content: string) => {
    setDrafts((current) => ({ ...current, [key]: content }));
    setStatus(null);
  };
  /** Mirrors native `<details>` toggles so one row stays open across dialog mounts. */
  const toggle = (key: string, opened: boolean) =>
    setOpen((current) => (opened ? key : current === key ? null : current));
  const startAdding = () => {
    setAdding(true);
    setOpen(NEW_SKILL);
  };
  const cancelAdding = () => {
    setAdding(false);
    forget(NEW_SKILL);
    setStatus(null);
  };
  return {
    items,
    drafts,
    open,
    adding,
    loading,
    saving,
    error,
    status,
    writePending,
    load,
    cancel,
    edit,
    toggle,
    startAdding,
    cancelAdding,
    save,
    remove,
  };
}
export type OwnerSkills = ReturnType<typeof useOwnerSkills>;

function SkillDisclosure({
  skills,
  name,
  skill,
  group,
  editor,
  onCancel,
  onRemove,
}: {
  skills: OwnerSkills;
  name: string;
  skill?: OwnerSkill;
  group: string;
  editor?: RefObject<HTMLTextAreaElement | null>;
  onCancel?: () => void;
  onRemove?: () => void;
}) {
  const saved = skill?.content ?? "";
  const draft = skills.drafts[name] ?? saved;
  const dirty = draft !== saved;
  const status = skills.status?.key === name ? skills.status : null;
  return (
    <details
      className="activity-rail-row project-mcp-connection"
      name={group}
      open={skills.open === name}
      onToggle={(event) => skills.toggle(name, event.currentTarget.open)}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: summary is the native keyboard-operable disclosure; cancel its default action only while a mutation owns the dialog. */}
      <summary
        aria-disabled={skills.saving}
        onClick={(event) => {
          if (skills.saving) event.preventDefault();
        }}
      >
        <span className="activity-rail-marker" aria-hidden="true" />
        <span className="activity-rail-summary">
          {skill ? name : "new skill"}
          {skill && <span className="activity-rail-headline"> · {skill.description}</span>}
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
          <TextFieldFrame>
            <textarea
              ref={editor}
              aria-label="SKILL.md"
              spellCheck={false}
              autoComplete="off"
              value={draft}
              disabled={skills.saving}
              onChange={(event) => skills.edit(name, event.target.value)}
            />
          </TextFieldFrame>
          <div className="personal-instructions-feedback">
            {status?.error ? (
              <span role="alert" className="personal-instructions-error">
                {status.error}
              </span>
            ) : (
              <span role="status">
                {status ? "Saved · next orb start" : dirty ? "Unsaved" : ""}
              </span>
            )}
            {skill ? (
              <button
                type="button"
                className="danger"
                disabled={skills.saving || skills.loading}
                onClick={onRemove}
              >
                remove
              </button>
            ) : (
              <button type="button" disabled={skills.saving} onClick={onCancel}>
                cancel
              </button>
            )}
            <button type="submit" disabled={skills.saving || skills.loading || !dirty}>
              Save
            </button>
          </div>
        </form>
      </div>
    </details>
  );
}

export function OwnerSkillsPane({ skills }: { skills: OwnerSkills }) {
  const group = useId();
  const addButton = useRef<HTMLButtonElement>(null);
  const newEditor = useRef<HTMLTextAreaElement>(null);
  // Focus moves after the commit that renders and re-enables its target.
  const focus = useRef<"add" | "new" | null>(null);
  useEffect(() => {
    const target = focus.current === "add" ? addButton.current : newEditor.current;
    if (focus.current === null || target === null || target.disabled) return;
    focus.current = null;
    target.focus();
  });
  return (
    <div className="project-secrets-body">
      {skills.items === null && skills.loading && <span className="muted">loading…</span>}
      {skills.items?.map((skill) => (
        <SkillDisclosure
          key={skill.name}
          skills={skills}
          name={skill.name}
          skill={skill}
          group={group}
          onRemove={() =>
            void skills.remove(skill.name).then((removed) => {
              if (removed) focus.current = "add";
            })
          }
        />
      ))}
      {skills.items !== null &&
        (skills.adding ? (
          <SkillDisclosure
            skills={skills}
            name={NEW_SKILL}
            group={group}
            editor={newEditor}
            onCancel={() => {
              skills.cancelAdding();
              focus.current = "add";
            }}
          />
        ) : (
          <div className="mcp-add-area">
            <button
              ref={addButton}
              type="button"
              className="text-action"
              disabled={skills.saving}
              onClick={() => {
                skills.startAdding();
                focus.current = "new";
              }}
            >
              add skill
            </button>
          </div>
        ))}
      {skills.error !== null && (
        <p className="banner banner-error" role="alert">
          {skills.error}{" "}
          <button type="button" disabled={skills.loading} onClick={() => void skills.load()}>
            Retry
          </button>
        </p>
      )}
    </div>
  );
}

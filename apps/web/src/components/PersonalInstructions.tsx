import { type PersonalInstructions, validatePersonalInstructions } from "@pi-orb/protocol";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { describeApiError, getPersonalInstructions, savePersonalInstructions } from "../lib/api.ts";
import { ClaudeAuthSettings } from "./ClaudeAuth.tsx";
import { ConfigTabs } from "./ConfigTabs.tsx";
import { GitIdentityPane, useGitIdentity } from "./GitIdentitySettings.tsx";
import { Icon } from "./Icons.tsx";
import { OwnerSkillsPane, useOwnerSkills } from "./OwnerSkillsSettings.tsx";
import { ProjectSecretsSettings } from "./ProjectSecretsSettings.tsx";
import { TextFieldFrame } from "./TextFieldFrame.tsx";

/** Account scope lives with home, never inside a project header. Drafts stay in memory only. */
export function PersonalInstructionsButton() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState(0);
  const [snapshot, setSnapshot] = useState<PersonalInstructions | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const gear = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const git = useGitIdentity(dialog);
  const skills = useOwnerSkills(dialog);
  const [secretsSaving, updateSecretsSaving] = useState(false);
  const setSecretsSaving = (next: boolean) => {
    // An explicit mutation may disable every control; keep keyboard focus inside the dialog.
    if (next) dialog.current?.focus();
    updateSecretsSaving(next);
  };
  const busy = saving || git.saving || skills.saving || secretsSaving;
  const epoch = useRef(0);
  const writePending = useRef(false);
  useEffect(
    () => () => {
      epoch.current++;
    },
    [],
  );
  useEffect(() => {
    if (open) closeButton.current?.focus();
  }, [open]);
  const dirty = snapshot !== null && draft !== snapshot.content;
  const validation = validatePersonalInstructions({ content: draft });

  const load = async () => {
    const request = ++epoch.current;
    setLoading(true);
    setError(null);
    setSaved(false);
    const result = await getPersonalInstructions();
    if (epoch.current !== request) return;
    setLoading(false);
    if (result.isErr()) {
      setError(describeApiError(result.error));
      setSnapshot(null);
      return;
    }
    setSnapshot(result.value);
    setDraft(result.value.content);
  };
  const close = () => {
    const pending = writePending.current || git.writePending.current || skills.writePending.current;
    if (pending || secretsSaving) return;
    epoch.current++;
    git.cancel();
    skills.cancel();
    setOpen(false);
    setLoading(false);
    gear.current?.focus();
  };
  const save = async () => {
    if (writePending.current || loading || !dirty || validation.isErr()) return;
    writePending.current = true;
    const request = ++epoch.current;
    dialog.current?.focus();
    setSaving(true);
    setError(null);
    setSaved(false);
    const result = await savePersonalInstructions(draft);
    if (epoch.current !== request) return;
    writePending.current = false;
    setSaving(false);
    if (result.isErr()) {
      setError(describeApiError(result.error));
      return;
    }
    setSnapshot(result.value);
    setDraft(result.value.content);
    setSaved(true);
  };
  return (
    <>
      <button
        ref={gear}
        className="icon-button personal-instructions-gear"
        type="button"
        title="Settings"
        aria-label="Settings"
        onClick={() => {
          setTab(0);
          setOpen(true);
          if (!dirty) void load();
          if (!git.dirty) void git.load();
          void skills.load();
        }}
      >
        <Icon name="gear" />
      </button>
      {open &&
        createPortal(
          <div className="project-secrets-backdrop personal-instructions-backdrop">
            <section
              ref={dialog}
              className="project-secrets-dialog personal-instructions-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="personal-instructions-title"
              tabIndex={-1}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  close();
                }
                if (event.key !== "Tab") return;
                const items = Array.from(
                  event.currentTarget.querySelectorAll<HTMLElement>(
                    "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href]",
                  ),
                ).filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0);
                const first = items[0],
                  last = items.at(-1);
                if (!first) {
                  event.preventDefault();
                  return;
                }
                if (
                  event.shiftKey &&
                  (document.activeElement === first ||
                    document.activeElement === event.currentTarget)
                ) {
                  event.preventDefault();
                  last?.focus();
                } else if (
                  !event.shiftKey &&
                  (document.activeElement === last ||
                    document.activeElement === event.currentTarget)
                ) {
                  event.preventDefault();
                  first.focus();
                }
              }}
            >
              <header className="project-secrets-header">
                <div>
                  <h2 id="personal-instructions-title">Settings</h2>
                  {tab === 2 && <p>Changes apply on next start</p>}
                </div>
                <button
                  ref={closeButton}
                  className="icon-button modal-close"
                  aria-label="Close settings"
                  title="Close settings"
                  type="button"
                  disabled={busy}
                  onClick={close}
                >
                  <Icon name="x" />
                </button>
              </header>
              <ConfigTabs
                id="owner-settings"
                label="Settings"
                names={["Instructions", "Skills", "Secrets", "Git", "Claude"]}
                selected={tab}
                onSelect={setTab}
                disabled={busy}
              />
              <div
                role="tabpanel"
                id="owner-settings-panel-0"
                aria-labelledby="owner-settings-tab-0"
                hidden={tab !== 0}
              >
                <form
                  className="project-instructions-editor"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void save();
                  }}
                >
                  <TextFieldFrame className="text-field-frame-inset">
                    <textarea
                      aria-label="Personal AGENTS.md"
                      spellCheck={false}
                      autoComplete="off"
                      value={draft}
                      disabled={loading || saving || snapshot === null}
                      onChange={(event) => {
                        setDraft(event.target.value);
                        setSaved(false);
                        setError(null);
                      }}
                    />
                  </TextFieldFrame>
                  <div className="personal-instructions-feedback">
                    {error !== null ? (
                      <span role="alert" className="personal-instructions-error">
                        {error}
                      </span>
                    ) : validation.isErr() && snapshot !== null ? (
                      <span role="alert" className="personal-instructions-error">
                        {validation.error.message}
                      </span>
                    ) : (
                      <span role="status">
                        {loading
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
                    {snapshot === null && !loading && (
                      <button type="button" onClick={() => void load()}>
                        Retry
                      </button>
                    )}
                    <button
                      type="submit"
                      disabled={loading || saving || !dirty || validation.isErr()}
                    >
                      Save
                    </button>
                  </div>
                </form>
              </div>
              <div
                role="tabpanel"
                id="owner-settings-panel-1"
                aria-labelledby="owner-settings-tab-1"
                hidden={tab !== 1}
              >
                <OwnerSkillsPane skills={skills} />
              </div>
              <div
                role="tabpanel"
                id="owner-settings-panel-2"
                aria-labelledby="owner-settings-tab-2"
                hidden={tab !== 2}
              >
                <ProjectSecretsSettings
                  project={null}
                  saving={secretsSaving}
                  setSaving={setSecretsSaving}
                />
              </div>
              <div
                role="tabpanel"
                id="owner-settings-panel-3"
                aria-labelledby="owner-settings-tab-3"
                hidden={tab !== 3}
              >
                <GitIdentityPane git={git} />
              </div>
              <div
                role="tabpanel"
                id="owner-settings-panel-4"
                aria-labelledby="owner-settings-tab-4"
                hidden={tab !== 4}
              >
                <ClaudeAuthSettings active={tab === 4} />
              </div>
            </section>
          </div>,
          document.body,
        )}
    </>
  );
}

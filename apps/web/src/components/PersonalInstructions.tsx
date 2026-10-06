import { type PersonalInstructions, validatePersonalInstructions } from "@pi-orb/protocol";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { describeApiError, getPersonalInstructions, savePersonalInstructions } from "../lib/api.ts";
import { ClaudeAuthSettings } from "./ClaudeAuth.tsx";
import { ConfigTabs } from "./ConfigTabs.tsx";
import { Icon } from "./Icons.tsx";
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
    if (writePending.current) return;
    epoch.current++;
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
                </div>
                <button
                  ref={closeButton}
                  className="icon-button modal-close"
                  aria-label="Close settings"
                  title="Close settings"
                  type="button"
                  disabled={saving}
                  onClick={close}
                >
                  <Icon name="x" />
                </button>
              </header>
              <ConfigTabs
                id="owner-settings"
                label="Settings"
                names={["Instructions", "Claude"]}
                selected={tab}
                onSelect={setTab}
                disabled={saving}
              />
              <div
                role="tabpanel"
                id="owner-settings-panel-0"
                aria-labelledby="owner-settings-tab-0"
                hidden={tab !== 0}
              >
                <form
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
                <ClaudeAuthSettings active={tab === 1} />
              </div>
            </section>
          </div>,
          document.body,
        )}
    </>
  );
}

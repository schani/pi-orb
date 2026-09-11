import type { ProjectView } from "@pi-orb/protocol";
import { useRef, useState } from "react";
import { useInitialFocus } from "../lib/use-initial-focus.ts";
import { ProjectGeneralSettings } from "./ProjectGeneralSettings.tsx";
import { ProjectMcpSettings } from "./ProjectMcpSettings.tsx";
import { ProjectSecretsSettings } from "./ProjectSecretsSettings.tsx";

const TABS = ["General", "MCPs", "Secrets"] as const;

export function ProjectConfigModal({
  project,
  onClose,
  onChanged,
  initialTabIndex = 0,
}: {
  project: ProjectView;
  initialTabIndex?: number;
  onClose: () => void;
  onChanged: (project: ProjectView) => void | Promise<void>;
}) {
  const [tab, setTab] = useState(initialTabIndex);
  const [saving, updateSaving] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const setSaving = (next: boolean) => {
    // An explicit mutation may disable every control; keep keyboard focus inside the dialog.
    if (next) dialog.current?.focus();
    updateSaving(next);
  };
  const initialTab = useRef<HTMLButtonElement>(null);
  useInitialFocus(initialTab);
  return (
    <div className="project-secrets-backdrop">
      <section
        className="project-secrets-dialog"
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-config-title"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !saving) {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
          if (event.key !== "Tab") return;
          const focusable = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              "button, input, select, textarea, [tabindex]",
            ),
          ).filter(
            (element) =>
              element.tabIndex >= 0 &&
              !element.matches(":disabled") &&
              element.getClientRects().length > 0,
          );
          if (focusable.length === 0) {
            event.preventDefault();
            return;
          }
          const first = focusable[0];
          const last = focusable.at(-1);
          if (
            event.shiftKey &&
            (document.activeElement === first || document.activeElement === event.currentTarget)
          ) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <header className="project-secrets-header">
          <div>
            <h2 id="project-config-title">Config for {project.name}</h2>
            {tab !== 1 && (
              <p>
                {tab === 0 ? "Repository applies to new checkouts" : "Changes apply on next start"}
              </p>
            )}
          </div>
          <button
            className="project-secrets-close"
            type="button"
            disabled={saving}
            onClick={onClose}
            aria-label="Close project config"
          >
            ×
          </button>
        </header>
        <div className="project-config-tabs" role="tablist" aria-label="Project config">
          {TABS.map((name, index) => (
            <button
              key={name}
              ref={index === initialTabIndex ? initialTab : undefined}
              type="button"
              role="tab"
              id={`project-config-tab-${index}`}
              aria-controls={`project-config-panel-${index}`}
              aria-selected={tab === index}
              tabIndex={tab === index ? 0 : -1}
              disabled={saving}
              onClick={() => setTab(index)}
              onKeyDown={(event) => {
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? TABS.length - 1
                      : event.key === "ArrowLeft"
                        ? (index + TABS.length - 1) % TABS.length
                        : event.key === "ArrowRight"
                          ? (index + 1) % TABS.length
                          : null;
                if (next === null) return;
                event.preventDefault();
                setTab(next);
                document.getElementById(`project-config-tab-${next}`)?.focus();
              }}
            >
              {name}
            </button>
          ))}
        </div>
        {/* Panels stay mounted: incomplete JSON and write-only secret drafts remain in memory only. */}
        <div
          role="tabpanel"
          id="project-config-panel-0"
          aria-labelledby="project-config-tab-0"
          hidden={tab !== 0}
        >
          <ProjectGeneralSettings
            project={project}
            saving={saving}
            setSaving={setSaving}
            onChanged={onChanged}
          />
        </div>
        <div
          role="tabpanel"
          id="project-config-panel-1"
          aria-labelledby="project-config-tab-1"
          hidden={tab !== 1}
        >
          <ProjectMcpSettings
            key={project.id}
            projectId={project.id}
            projectName={project.name}
            active={tab === 1}
            saving={saving}
            setSaving={setSaving}
          />
        </div>
        <div
          role="tabpanel"
          id="project-config-panel-2"
          aria-labelledby="project-config-tab-2"
          hidden={tab !== 2}
        >
          <ProjectSecretsSettings
            key={project.id}
            project={project}
            active={tab === 2}
            saving={saving}
            setSaving={setSaving}
          />
        </div>
      </section>
    </div>
  );
}

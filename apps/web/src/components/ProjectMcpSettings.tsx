import type { McpCatalog, McpConfig, ProjectMcpStatus } from "@pi-orb/protocol";
import { useEffect, useId, useRef, useState } from "react";
import {
  connectMcpOAuth,
  describeApiError,
  describeProjectMcp,
  getProjectMcp,
  getProjectMcpStatus,
  listProjectSecrets,
  saveProjectMcp,
} from "../lib/api.ts";
import {
  editableMcp,
  emptyMcpDraft,
  MCP_PRESETS,
  type McpDraft,
  mcpConfig,
  mcpDraft,
} from "../lib/mcp-form.ts";
import { launchSafariAuth, safariAuthUrl } from "../lib/safari-links.ts";
import { Icon } from "./Icons.tsx";
import { useMcpAuthorization } from "./McpOAuthControls.tsx";
import { TextFieldFrame } from "./TextFieldFrame.tsx";

interface Shared {
  projectId: string;
  saving: boolean;
  setSaving: (saving: boolean) => void;
}
interface EditorProps {
  previous?: McpConfig;
  saving: boolean;
  secrets: readonly string[];
  onSave: (draft: McpDraft, previous?: McpConfig) => Promise<void>;
  onCancel: () => void;
  refreshSecrets: () => void;
}
export function McpEditor({
  previous,
  saving,
  secrets,
  onSave,
  onCancel,
  refreshSecrets,
}: EditorProps) {
  const [draft, setDraft] = useState(() => (previous ? mcpDraft(previous) : emptyMcpDraft()));
  const [presets, setPresets] = useState(false);
  const id = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (previous) setDraft(mcpDraft(previous));
  }, [previous]);
  useEffect(() => {
    if (!previous) nameInput.current?.focus();
  }, [previous]);
  const change = <K extends keyof McpDraft>(key: K, value: McpDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  return (
    <form
      className="project-mcp-ledger"
      autoComplete="off"
      data-1p-ignore="true"
      onSubmit={(event) => {
        event.preventDefault();
        if (!saving) void onSave(draft, previous);
      }}
    >
      <label>
        Name
        <TextFieldFrame>
          <input
            ref={nameInput}
            required
            maxLength={64}
            pattern="[a-z][a-z0-9_-]{0,63}"
            readOnly={!!previous}
            disabled={saving}
            value={draft.name}
            data-1p-ignore="true"
            onChange={(e) => change("name", e.target.value)}
          />
        </TextFieldFrame>
      </label>
      <label>
        Endpoint
        <TextFieldFrame>
          <input
            type="url"
            required
            pattern="https://.+"
            maxLength={2048}
            disabled={saving}
            value={draft.url}
            onChange={(e) => change("url", e.target.value)}
          />
        </TextFieldFrame>
      </label>
      <label>
        Authentication
        <select
          aria-label="Authentication"
          disabled={saving}
          value={draft.auth}
          onChange={(e) => change("auth", e.target.value === "oauth" ? "oauth" : "bearer")}
        >
          <option value="oauth">OAuth</option>
          <option value="bearer">Bearer token</option>
        </select>
      </label>
      {draft.auth === "bearer" && (
        <label>
          Token secret
          <select
            aria-label="Token secret"
            required
            disabled={saving}
            value={draft.secret}
            onFocus={refreshSecrets}
            onChange={(e) => change("secret", e.target.value)}
          >
            <option value="">Select a secret</option>
            {draft.secret && !secrets.includes(draft.secret) && (
              <option disabled value={draft.secret}>
                {draft.secret} (unavailable)
              </option>
            )}
            {secrets.map((secret) => (
              <option key={secret} value={secret}>
                {secret}
              </option>
            ))}
          </select>
        </label>
      )}
      {previous && (
        <label className="mcp-full">
          Description
          <TextFieldFrame>
            <input
              maxLength={240}
              disabled={saving}
              value={draft.description}
              onChange={(e) => change("description", e.target.value)}
            />
          </TextFieldFrame>
        </label>
      )}
      <div className="mcp-full mcp-actions">
        {!previous && (
          <button
            type="button"
            className="text-action"
            disabled={saving}
            aria-expanded={presets}
            aria-controls={`${id}-presets`}
            onClick={() => setPresets((p) => !p)}
          >
            preset
          </button>
        )}
        <span className="mcp-action-space" />
        <button
          type="button"
          disabled={saving}
          onClick={() => {
            if (previous) setDraft(mcpDraft(previous));
            onCancel();
          }}
        >
          cancel
        </button>
        <button
          type="submit"
          disabled={saving || (draft.auth === "bearer" && !secrets.includes(draft.secret))}
        >
          {previous ? "save" : draft.auth === "oauth" ? "add & connect" : "add server"}
        </button>
      </div>
      {!previous && (
        <div id={`${id}-presets`} className="mcp-full mcp-presets" hidden={!presets}>
          {MCP_PRESETS.map((preset) => (
            <button
              type="button"
              className="text-action"
              key={preset.name}
              disabled={saving}
              onClick={() => {
                setDraft((d) => ({ ...d, ...preset, name: d.name || preset.name }));
                setPresets(false);
              }}
            >
              {preset.label}
            </button>
          ))}
        </div>
      )}
    </form>
  );
}

export function mcpAuthorizationLabel(status: string): string {
  return status === "connected" ? "grant stored" : status;
}

const healthDiagnostics = {
  auth_required: "Authorization required",
  invalid_binding: "Invalid MCP configuration",
  connection_failed: "Connection failed",
  credentials_unavailable: "Credentials unavailable",
};

function Connection({
  server,
  autoOpen,
  onOpened,
  group,
  onRemove,
  health,
  checking,
  ...props
}: Shared &
  Omit<EditorProps, "previous" | "onCancel"> & {
    server: McpConfig;
    health: ProjectMcpStatus["servers"][number] | undefined;
    checking: boolean;
    autoOpen: boolean;
    onOpened: () => void;
    group: string;
    onRemove: (server: McpConfig) => Promise<void>;
  }) {
  const details = useRef<HTMLDetailsElement>(null);
  const authorization = useMcpAuthorization(props.projectId, server.oauth?.id, props.setSaving);
  useEffect(() => {
    if (autoOpen && !props.saving && details.current) {
      details.current.open = true;
      details.current.querySelector("summary")?.focus();
      onOpened();
    }
  }, [autoOpen, props.saving, onOpened]);
  const editable = editableMcp(server);
  const status = server.oauth
    ? authorization.error
      ? "authorization unavailable"
      : authorization.status === "auth_required"
        ? "authorization required"
        : mcpAuthorizationLabel(authorization.status) || "checking authorization…"
    : editable
      ? "bearer token"
      : "custom headers";
  const observed = health?.status ?? "unknown";
  return (
    <details className="activity-rail-row project-mcp-connection" name={group} ref={details}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: summary is the native keyboard-operable disclosure; cancel its default action only while a mutation owns the dialog. */}
      <summary
        aria-disabled={props.saving}
        onClick={(event) => {
          if (props.saving) event.preventDefault();
        }}
      >
        <span className="activity-rail-marker" aria-hidden="true" />
        <span className="activity-rail-summary">
          {server.name}
          <span
            className={`mcp-health mcp-health-${observed}`}
            title={`Control-plane connection and discovery${health?.diagnostic ? ` · ${healthDiagnostics[health.diagnostic]}` : ""}`}
          >
            {checking ? "checking…" : observed === "needs-auth" ? "auth required" : observed}
          </span>
          <span className="activity-rail-headline">{status}</span>
        </span>
      </summary>
      <div className="reasoning-body">
        {editable ? (
          <McpEditor
            {...props}
            previous={server}
            onCancel={() => {
              if (details.current) details.current.open = false;
            }}
          />
        ) : (
          <p className="banner banner-error">
            This connection uses custom headers that this editor cannot change.
          </p>
        )}
        <div className="mcp-actions">
          {server.oauth && (
            <>
              <button
                type="button"
                disabled={props.saving}
                onClick={() => void authorization.connect()}
              >
                {authorization.status === "connected" ? "reconnect" : "connect"}
              </button>
              {(authorization.status === "connected" || authorization.status === "pending") && (
                <button
                  type="button"
                  disabled={props.saving}
                  onClick={() => void authorization.disconnect()}
                >
                  disconnect
                </button>
              )}
            </>
          )}
          <span className="mcp-action-space" />
          <button
            type="button"
            className="danger"
            disabled={props.saving}
            onClick={() => void onRemove(server)}
          >
            remove server
          </button>
        </div>
        {authorization.error && (
          <p className="banner banner-error" role="alert">
            {authorization.error}
          </p>
        )}
      </div>
    </details>
  );
}

export function ProjectMcpSettings({
  projectId,
  projectName,
  saving,
  setSaving,
  active = true,
}: Shared & { projectName: string; active?: boolean }) {
  const [loadedCatalog, setLoadedCatalog] = useState<{
    projectId: string;
    value: McpCatalog;
  } | null>(null);
  const catalog = loadedCatalog?.projectId === projectId ? loadedCatalog.value : null;
  const [adding, setAdding] = useState(false);
  const [openName, setOpenName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secrets, setSecrets] = useState<string[]>([]);
  const [secretError, setSecretError] = useState<string | null>(null);
  const [healthRead, setHealthRead] = useState<{
    projectId: string;
    revision: number;
    report?: ProjectMcpStatus;
    failed: boolean;
    checking: boolean;
  } | null>(null);
  const refreshHealth = useRef(() => {});
  const inFlight = useRef(false);
  const revision = catalog?.revision;
  const currentHealth =
    healthRead?.projectId === projectId && healthRead.revision === revision ? healthRead : null;
  const health =
    currentHealth?.report && currentHealth.report.revision === revision
      ? currentHealth.report
      : undefined;
  useEffect(() => {
    if (!active || revision === undefined) return;
    let current = true;
    const load = () => {
      if (inFlight.current) return;
      inFlight.current = true;
      setHealthRead({ projectId, revision, failed: false, checking: true });
      void getProjectMcpStatus(projectId).then((result) => {
        inFlight.current = false;
        if (!current) {
          refreshHealth.current();
          return;
        }
        setHealthRead({
          projectId,
          revision,
          failed: result.isErr(),
          checking: false,
          ...(result.isOk() ? { report: result.value } : {}),
        });
      });
    };
    load();
    refreshHealth.current = load;
    window.addEventListener("focus", load);
    return () => {
      current = false;
      refreshHealth.current = () => {};
      window.removeEventListener("focus", load);
    };
  }, [active, projectId, revision]);
  const group = useId();
  const addButton = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  const lifetime = useRef(0);
  const secretRead = useRef(0);
  const refreshSecrets = () => {
    const request = ++secretRead.current;
    void listProjectSecrets(projectId).then((result) => {
      if (!alive.current || request !== secretRead.current) return;
      if (result.isOk()) {
        setSecrets(result.value.items.map((item) => item.name));
        setSecretError(null);
      } else setSecretError(describeApiError(result.error));
    });
  };
  useEffect(() => {
    alive.current = true;
    lifetime.current++;
    let current = true;
    void getProjectMcp(projectId).then((result) => {
      if (!current) return;
      if (result.isOk()) setLoadedCatalog({ projectId, value: result.value });
      else setError(describeApiError(result.error));
    });
    return () => {
      current = false;
      alive.current = false;
      lifetime.current++;
      secretRead.current++;
    };
  }, [projectId]);
  // Refresh secret suggestions whenever this tab activates, without owning the draft or focus.
  useEffect(() => {
    if (!active) return;
    let current = true;
    const request = ++secretRead.current;
    void listProjectSecrets(projectId).then((result) => {
      if (!current || request !== secretRead.current) return;
      if (result.isOk()) {
        setSecrets(result.value.items.map((item) => item.name));
        setSecretError(null);
      } else setSecretError(describeApiError(result.error));
    });
    return () => {
      current = false;
    };
  }, [active, projectId]);
  const save = async (draft: McpDraft, previous?: McpConfig) => {
    if (!catalog || saving) return;
    const owner = lifetime.current;
    const config = mcpConfig(draft, previous);
    if (config.isErr()) {
      setError(config.error);
      return;
    }
    if (catalog.servers.some((s) => s.name === config.value.name && s.name !== previous?.name)) {
      setError("That server name already exists.");
      return;
    }
    setSaving(true);
    setError(null);
    if (!config.value.oauth) {
      const inspection = await describeProjectMcp(projectId, config.value);
      if (owner !== lifetime.current) {
        setSaving(false);
        return;
      }
      if (inspection.isErr()) {
        if (
          !previous ||
          !window.confirm(`${describeApiError(inspection.error)}. Save without validation?`)
        ) {
          setError(describeApiError(inspection.error));
          setSaving(false);
          return;
        }
      } else if (!draft.description.trim()) config.value.description = inspection.value.description;
    }
    const result = await saveProjectMcp(projectId, {
      revision: catalog.revision,
      servers: [...catalog.servers.filter((s) => s.name !== previous?.name), config.value].sort(
        (a, b) => a.name.localeCompare(b.name),
      ),
    });
    if (owner !== lifetime.current) {
      setSaving(false);
      return;
    }
    if (result.isErr()) {
      setError(describeApiError(result.error));
      setSaving(false);
      return;
    }
    setLoadedCatalog({ projectId, value: result.value });
    setAdding(false);
    setOpenName(config.value.name);
    if (config.value.oauth && (!previous?.oauth || config.value.oauth.id !== previous.oauth.id)) {
      const safari = safariAuthUrl(`/projects/${encodeURIComponent(projectId)}/mcp`);
      if (safari !== null) {
        setSaving(false);
        const launched = launchSafariAuth(safari);
        if (launched.isErr()) setError("Server saved. Could not open Safari. Try Connect again.");
        return;
      }
      const connected = await connectMcpOAuth(projectId, config.value.oauth.id);
      if (owner !== lifetime.current) {
        setSaving(false);
        return;
      }
      if (connected.isOk()) {
        window.location.assign(connected.value.url);
        return;
      }
      setError(`Server saved; authorization could not start. ${describeApiError(connected.error)}`);
    }
    setSaving(false);
  };
  const remove = async (server: McpConfig) => {
    if (!catalog || saving || !window.confirm(`Remove ${server.name} from ${projectName}?`)) return;
    setSaving(true);
    setError(null);
    const owner = lifetime.current;
    const result = await saveProjectMcp(projectId, {
      revision: catalog.revision,
      servers: catalog.servers.filter((s) => s.name !== server.name),
    });
    setSaving(false);
    if (owner !== lifetime.current) return;
    if (result.isErr()) setError(describeApiError(result.error));
    else {
      setLoadedCatalog({ projectId, value: result.value });
      setOpenName(null);
      queueMicrotask(() => addButton.current?.focus());
    }
  };
  return (
    <div className="project-secrets-body">
      {catalog === null && !error && <span className="muted">loading…</span>}
      {catalog && catalog.servers.length > 0 && (
        <div className="mcp-health-toolbar">
          <button
            type="button"
            className="icon-button"
            title="Refresh MCP health"
            aria-label="Refresh MCP health"
            disabled={!active || saving || currentHealth?.checking}
            onClick={() => refreshHealth.current()}
          >
            <Icon name="refresh" />
          </button>
        </div>
      )}
      {currentHealth?.failed && (
        <p className="banner banner-error" role="alert">
          Could not check MCP health.
        </p>
      )}
      {catalog?.servers.map((server) => (
        <Connection
          key={server.name}
          server={server}
          health={health?.servers.find((row) => row.name === server.name)}
          checking={currentHealth?.checking ?? false}
          projectId={projectId}
          saving={saving}
          setSaving={setSaving}
          autoOpen={openName === server.name}
          onOpened={() => setOpenName(null)}
          group={group}
          secrets={secrets}
          refreshSecrets={refreshSecrets}
          onSave={save}
          onRemove={remove}
        />
      ))}
      {catalog && (
        <div className="mcp-add-area">
          {adding ? (
            <>
              <div className="mcp-add-heading">add server</div>
              <McpEditor
                saving={saving}
                secrets={secrets}
                refreshSecrets={refreshSecrets}
                onSave={save}
                onCancel={() => {
                  setAdding(false);
                  queueMicrotask(() => addButton.current?.focus());
                }}
              />
            </>
          ) : (
            <button
              ref={addButton}
              type="button"
              className="text-action"
              disabled={saving || catalog.servers.length >= 20}
              onClick={() => {
                setAdding(true);
                setOpenName(null);
              }}
            >
              add server
            </button>
          )}
        </div>
      )}
      {secretError && (
        <p className="banner banner-error" role="alert">
          Could not load token secret names. {secretError}
        </p>
      )}
      {error && (
        <p className="banner banner-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

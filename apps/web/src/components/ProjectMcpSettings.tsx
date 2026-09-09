import { type McpCatalog, McpConfigSchema } from "@pi-orb/protocol";
import { Result } from "neverthrow";
import { type FormEvent, useEffect, useState } from "react";
import { Check } from "typebox/value";
import { describeApiError, describeProjectMcp, getProjectMcp, saveProjectMcp } from "../lib/api.ts";

const CUSTOM_HEADERS = JSON.stringify(
  { Authorization: { secret: "TOKEN", prefix: "Bearer " } },
  null,
  2,
);

export function ProjectMcpSettings({
  projectId,
  projectName,
  saving,
  setSaving,
}: {
  projectId: string;
  projectName: string;
  saving: boolean;
  setSaving: (saving: boolean) => void;
}) {
  const [catalog, setCatalog] = useState<McpCatalog | null>(null);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("");
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [headers, setHeaders] = useState(CUSTOM_HEADERS);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void getProjectMcp(projectId).then((result) => {
      if (!active) return;
      if (result.isOk()) setCatalog(result.value);
      else setError(describeApiError(result.error));
    });
    return () => {
      active = false;
    };
  }, [projectId]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!catalog || saving) return;
    const parsed = Result.fromThrowable(
      () => JSON.parse(headers) as unknown,
      () => "Invalid header bindings JSON",
    )();
    if (parsed.isErr()) {
      setError(parsed.error);
      return;
    }
    const config = {
      name: name.trim(),
      url: url.trim(),
      description: description.trim() || "MCP server",
      headers: parsed.value,
    };
    if (!Check(McpConfigSchema, config)) {
      setError("Use a lowercase server name, HTTPS URL, and valid header bindings.");
      return;
    }
    setSaving(true);
    setError(null);
    const inspected = await describeProjectMcp(projectId, config);
    if (
      inspected.isErr() &&
      (!description.trim() ||
        !window.confirm(`${describeApiError(inspected.error)}. Save without validation?`))
    ) {
      setSaving(false);
      setError(describeApiError(inspected.error));
      return;
    }
    const summary = description.trim() || (inspected.isOk() ? inspected.value.description : "");
    if (!summary) {
      setSaving(false);
      setError("Server supplies no description. Enter a short description.");
      return;
    }
    const next = { ...config, description: summary };
    const result = await saveProjectMcp(projectId, {
      revision: catalog.revision,
      servers: [...catalog.servers.filter((s) => s.name !== config.name), next].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    });
    setSaving(false);
    if (result.isErr()) {
      setError(describeApiError(result.error));
      return;
    }
    setCatalog(result.value);
    setEditing(false);
    setName("");
    setUrl("");
    setDescription("");
    setHeaders(CUSTOM_HEADERS);
    setProvider("");
  };
  const remove = async (server: string) => {
    if (!catalog || !window.confirm(`Remove ${server} from ${projectName} on next start?`)) return;
    setSaving(true);
    setError(null);
    const result = await saveProjectMcp(projectId, {
      revision: catalog.revision,
      servers: catalog.servers.filter((s) => s.name !== server),
    });
    setSaving(false);
    if (result.isErr()) setError(describeApiError(result.error));
    else setCatalog(result.value);
  };
  return (
    <div className="project-secrets-body">
      {catalog?.servers.map((server) => (
        <div className="project-secret-row" key={server.name}>
          <span>{server.name}</span>
          <span className="project-secret-actions">
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                setEditing(true);
                setProvider("");
                setName(server.name);
                setUrl(server.url);
                setDescription(server.description);
                setHeaders(JSON.stringify(server.headers, null, 2));
              }}
            >
              edit
            </button>
            <button type="button" disabled={saving} onClick={() => void remove(server.name)}>
              remove
            </button>
          </span>
        </div>
      ))}
      {error && (
        <p role="alert" className="banner banner-error">
          {error}
        </p>
      )}
      <form
        onSubmit={(event) => void save(event)}
        className="project-secret-form project-mcp-form"
        autoComplete="off"
        data-1p-ignore="true"
      >
        <select
          aria-label="Provider"
          value={provider}
          disabled={saving}
          onChange={(e) => {
            const provider = e.target.value;
            setProvider(provider);
            setEditing(false);
            setError(null);
            if (!provider) {
              setName("");
              setUrl("");
              setDescription("");
              setHeaders(CUSTOM_HEADERS);
              return;
            }
            setName(provider);
            setDescription("");
            setUrl(provider === "datadog" ? "" : `https://mcp.${provider}.com/mcp`);
            setHeaders(
              JSON.stringify(
                provider === "datadog"
                  ? {
                      DD_API_KEY: { secret: "DD_API_KEY" },
                      DD_APPLICATION_KEY: { secret: "DD_APPLICATION_KEY" },
                    }
                  : {
                      Authorization: {
                        secret: provider === "posthog" ? "POSTHOG_KEY" : "CLOUDFLARE_TOKEN",
                        prefix: "Bearer ",
                      },
                    },
                null,
                2,
              ),
            );
          }}
        >
          <option value="">Custom</option>
          <option value="posthog">PostHog</option>
          <option value="cloudflare">Cloudflare</option>
          <option value="datadog">Datadog</option>
        </select>
        <label>
          Name
          <input
            autoComplete="off"
            data-1p-ignore="true"
            readOnly={editing}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            disabled={saving}
          />
        </label>
        <label>
          Endpoint
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            type="url"
            required
            disabled={saving}
          />
        </label>
        <label>
          Description
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={240}
            placeholder="Read from server when omitted"
            disabled={saving}
          />
        </label>
        <button
          type="button"
          disabled={saving || !catalog}
          onClick={() =>
            void (async () => {
              const parsed = Result.fromThrowable(
                () => JSON.parse(headers) as unknown,
                () => "Invalid header bindings JSON",
              )();
              const config = {
                name,
                url,
                description: description || "MCP server",
                headers: parsed.isOk() ? parsed.value : null,
              };
              if (!Check(McpConfigSchema, config)) {
                setError("Invalid MCP configuration");
                return;
              }
              setSaving(true);
              setError(null);
              const result = await describeProjectMcp(projectId, config);
              setSaving(false);
              if (result.isErr()) setError(describeApiError(result.error));
              else setDescription(result.value.description);
            })()
          }
        >
          fetch description
        </button>
        <label>
          Header bindings
          <textarea
            value={headers}
            onChange={(e) => setHeaders(e.target.value)}
            rows={5}
            spellCheck={false}
            disabled={saving}
            aria-label="Header bindings"
            placeholder={'{"Authorization":{"secret":"TOKEN","prefix":"Bearer "}}'}
          />
        </label>
        <button type="submit" disabled={saving || !catalog}>
          {saving ? "saving…" : "save"}
        </button>
      </form>
    </div>
  );
}

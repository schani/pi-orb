import { type McpConfig, McpConfigSchema } from "@pi-orb/protocol";
import { err, ok, type Result } from "neverthrow";
import { Check } from "typebox/value";
import { generateUuid } from "./uuid.ts";

export interface McpDraft {
  name: string;
  url: string;
  auth: "oauth" | "bearer";
  secret: string;
  description: string;
}
export const emptyMcpDraft = (): McpDraft => ({
  name: "",
  url: "",
  auth: "oauth",
  secret: "",
  description: "",
});
export const MCP_PRESETS = [
  {
    name: "cloudflare",
    label: "Cloudflare",
    url: "https://mcp.cloudflare.com/mcp",
    auth: "oauth",
    secret: "",
  },
  {
    name: "datadog",
    label: "Datadog US5",
    url: "https://mcp.us5.datadoghq.com/v1/mcp",
    auth: "oauth",
    secret: "",
  },
  {
    name: "posthog",
    label: "PostHog",
    url: "https://mcp.posthog.com/mcp",
    auth: "bearer",
    secret: "POSTHOG_KEY",
  },
] as const;

/** Never silently discard headers that this intentionally narrow editor cannot represent. */
export function editableMcp(config: McpConfig): boolean {
  const entries = Object.entries(config.headers);
  if (config.oauth) return entries.length === 0;
  return (
    entries.length === 1 &&
    entries[0]?.[0].toLowerCase() === "authorization" &&
    "secret" in entries[0][1] &&
    entries[0][1].prefix === "Bearer "
  );
}
export function mcpDraft(config: McpConfig): McpDraft {
  const authorization = Object.entries(config.headers).find(
    ([key]) => key.toLowerCase() === "authorization",
  )?.[1];
  return {
    name: config.name,
    url: config.url,
    description: config.description,
    auth: config.oauth ? "oauth" : "bearer",
    secret: authorization && "secret" in authorization ? authorization.secret : "",
  };
}
export function mcpConfig(draft: McpDraft, previous?: McpConfig): Result<McpConfig, string> {
  if (previous && !editableMcp(previous))
    return err("This connection uses custom headers that this editor cannot change.");
  const config = {
    name: draft.name.trim(),
    url: draft.url.trim(),
    description: draft.description.trim() || `${draft.name.trim()} MCP`,
    headers:
      draft.auth === "bearer"
        ? { Authorization: { secret: draft.secret.trim(), prefix: "Bearer " as const } }
        : {},
    ...(draft.auth === "oauth"
      ? {
          oauth: {
            id:
              previous?.oauth && previous.url === draft.url.trim()
                ? previous.oauth.id
                : generateUuid(),
          },
        }
      : {}),
  };
  return Check(McpConfigSchema, config)
    ? ok(config)
    : err("Use a lowercase name, HTTPS endpoint, and a valid token secret name.");
}

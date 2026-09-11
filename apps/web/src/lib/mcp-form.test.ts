import type { McpConfig } from "@pi-orb/protocol";
import { describe, expect, it } from "vitest";
import { editableMcp, emptyMcpDraft, mcpConfig, mcpDraft } from "./mcp-form.ts";

const original: McpConfig = {
  name: "cloudflare",
  url: "https://mcp.cloudflare.com/mcp",
  description: "Cloudflare",
  headers: {},
  oauth: { id: "10000000-0000-4000-8000-000000000001" },
};
describe("compact MCP editor", () => {
  it("keeps authorization identity on description edits, not endpoint replacement", () => {
    const draft = mcpDraft(original);
    expect(mcpConfig({ ...draft, description: "New" }, original)._unsafeUnwrap().oauth).toEqual(
      original.oauth,
    );
    expect(
      mcpConfig({ ...draft, url: "https://other.example/mcp" }, original)._unsafeUnwrap().oauth?.id,
    ).not.toBe(original.oauth?.id);
  });
  it("represents bearer authentication as one secret reference", () => {
    const config = mcpConfig(
      { ...mcpDraft(original), auth: "bearer", secret: "POSTHOG_KEY" },
      original,
    )._unsafeUnwrap();
    expect(config.oauth).toBeUndefined();
    expect(config.headers).toEqual({ Authorization: { secret: "POSTHOG_KEY", prefix: "Bearer " } });
    expect(editableMcp(config)).toBe(true);
    expect(mcpDraft(config).secret).toBe("POSTHOG_KEY");
  });
  it("never silently deletes extra context or non-bearer credentials", () => {
    for (const config of [
      { ...original, headers: { "X-Project": { literal: "pin" } } },
      {
        name: "dd",
        url: "https://example.com/mcp",
        description: "DD",
        headers: { DD_API_KEY: { secret: "DD_API_KEY" } },
      },
    ]) {
      expect(editableMcp(config)).toBe(false);
      expect(mcpConfig(mcpDraft(config), config).isErr()).toBe(true);
    }
  });
  it("rejects malformed names, endpoints and secret references", () => {
    expect(mcpConfig(emptyMcpDraft()).isErr()).toBe(true);
    expect(mcpConfig({ ...mcpDraft(original), url: "http://example.com/mcp" }).isErr()).toBe(true);
    expect(mcpConfig({ ...mcpDraft(original), auth: "bearer", secret: "not a key" }).isErr()).toBe(
      true,
    );
  });
});

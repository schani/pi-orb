import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { McpConfigSchema } from "./mcp.ts";

describe("project MCP configuration", () => {
  const config = {
    name: "datadog",
    description: "Logs and metrics",
    url: "https://example.com/mcp",
    headers: { DD_API_KEY: { secret: "DD_API_KEY" }, DD_APPLICATION_KEY: { secret: "DD_APP_KEY" } },
  };
  it("accepts multiple secret references and non-secret context headers", () => {
    expect(Check(McpConfigSchema, config)).toBe(true);
    expect(
      Check(McpConfigSchema, {
        ...config,
        headers: {
          Authorization: { secret: "TOKEN", prefix: "Bearer " },
          "x-posthog-project-id": { literal: "123" },
        },
      }),
    ).toBe(true);
  });
  it("rejects unknown fields, command strings, and credential URL userinfo", () => {
    expect(Check(McpConfigSchema, { ...config, oauth: {} })).toBe(false);
    expect(Check(McpConfigSchema, { ...config, headers: { Authorization: "!command" } })).toBe(
      false,
    );
    expect(
      Check(McpConfigSchema, { ...config, url: "https://user:password@example.com/mcp" }),
    ).toBe(false);
  });
});

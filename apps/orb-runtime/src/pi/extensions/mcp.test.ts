import { expect, it } from "vitest";
import { mcpInventoryPrompt } from "./mcp.ts";

it("lists the approved server inventory without connecting or exposing URLs", () => {
  expect(
    mcpInventoryPrompt([
      {
        name: "posthog",
        description: "Analytics\nread-only",
        url: "https://mcp.posthog.com/mcp",
        headers: {},
      },
    ]),
  ).toBe("Available MCP servers:\n- posthog: Analytics read-only");
  expect(mcpInventoryPrompt([])).toBeNull();
});

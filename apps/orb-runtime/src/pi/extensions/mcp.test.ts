import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { McpTools } from "../../mcp/tools.ts";
import { createMcpExtension, mcpInventoryPrompt } from "./mcp.ts";

it("registers exactly three fixed tools, adds a bounded inventory, and owns cleanup", async () => {
  const tools: { name: string }[] = [];
  const handlers = new Map<string, (...args: never[]) => unknown>();
  const api = {
    registerTool: (tool: { name: string }) => tools.push(tool),
    on: (event: string, f: (...args: never[]) => unknown) => handlers.set(event, f),
  } as unknown as ExtensionAPI;
  const factory = createMcpExtension({
    configs: [
      {
        name: "posthog",
        description: "Analytics",
        url: "https://mcp.posthog.com/mcp",
        headers: {},
      },
    ],
    tools: new McpTools(new Map()),
  });
  factory(api);
  expect(tools.map((t) => t.name)).toEqual(["mcp_search", "mcp_call", "mcp_read"]);
  expect(handlers.has("before_agent_start")).toBe(false);
  expect(
    mcpInventoryPrompt([
      {
        name: "posthog",
        description: "Analytics",
        url: "https://mcp.posthog.com/mcp",
        headers: {},
      },
    ]),
  ).toBe("Available MCP servers:\n- posthog: Analytics");
  expect(mcpInventoryPrompt([])).toBeNull();
  await handlers.get("session_shutdown")?.();
});

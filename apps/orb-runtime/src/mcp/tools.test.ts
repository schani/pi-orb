import { NoSimulationTask } from "determined";
import { ok } from "neverthrow";
import { describe, expect, it } from "vitest";
import { McpConnection, type McpOperation } from "./service.ts";
import { McpTools } from "./tools.ts";

const task = new NoSimulationTask("mcp-tools", false);
function fixture() {
  const operations: McpOperation[] = [];
  const connection = new McpConnection(task, {
    connect: async () =>
      ok({
        perform: async (_task, op) => {
          operations.push(op);
          return ok(
            op.method === "catalog"
              ? [
                  {
                    kind: "tool",
                    name: "search_logs",
                    description: "Find logs",
                    inputSchema: { type: "object" },
                  },
                  {
                    kind: "prompt",
                    name: "investigate",
                    description: "Investigate logs",
                    arguments: [],
                  },
                  {
                    kind: "resource",
                    name: "logs",
                    uri: "logs://recent",
                    description: "Recent logs",
                  },
                  {
                    kind: "template",
                    name: "log",
                    uriTemplate: "logs://{id}",
                    description: "Individual logs",
                  },
                ]
              : {
                  messages: [{ role: "user", content: { type: "text", text: "External prompt" } }],
                },
          );
        },
        close: async () => ok(undefined),
      }),
  });
  return { tools: new McpTools(new Map([["datadog", connection]])), operations };
}
describe("fixed MCP tools", () => {
  it("searches all kinds by default and filters only when requested", async () => {
    const { tools } = fixture();
    const all = await tools.search({ query: "logs" });
    expect(all._unsafeUnwrap().items.map((i) => i.kind)).toEqual([
      "tool",
      "prompt",
      "resource",
      "template",
    ]);
    const filtered = await tools.search({ query: "logs", kind: "resource" });
    expect(filtered._unsafeUnwrap().items.map((i) => i.kind)).toEqual(["resource"]);
  });
  it("reads templates locally and prompts as data; calls only invoke tools", async () => {
    const { tools, operations } = fixture();
    const template = await tools.read({ server: "datadog", kind: "template", name: "log" });
    expect(template._unsafeUnwrap()).toMatchObject({ uriTemplate: "logs://{id}" });
    expect(operations.map((op) => op.method)).toEqual(["catalog"]);
    const prompt = await tools.read({
      server: "datadog",
      kind: "prompt",
      name: "investigate",
      args: {},
    });
    expect(prompt._unsafeUnwrap()).toMatchObject({
      source: { server: "datadog", kind: "prompt" },
      data: { messages: [{ role: "user" }] },
    });
    await tools.call({ server: "datadog", tool: "search_logs", args: {} });
    expect(operations.at(-1)?.method).toBe("tools/call");
    expect(
      (await tools.call({ server: "other-project", tool: "search_logs", args: {} })).isErr(),
    ).toBe(true);
  });
});

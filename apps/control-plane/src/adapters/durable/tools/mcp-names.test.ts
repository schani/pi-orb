import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { errAsync, okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { CallableCatalog } from "./catalog.ts";
import { type McpServerStatus, McpTools } from "./mcp.ts";
import { openCodemodeHarness } from "./testkit/codemode.ts";

function endpoint(name: string, names: string[]) {
  const state = { names, fail: false, calls: [] as string[] };
  return {
    state,
    name,
    connect: () => {
      if (state.fail) return errAsync({ code: "unavailable" as const, message: "private" });
      const { client, server } = createInMemoryTransportPair();
      server.onMessage((message) => {
        if (!("method" in message) || !("id" in message)) return;
        const respond = (result: unknown) =>
          server.send({ jsonrpc: "2.0", id: message.id, result });
        if (message.method === "initialize")
          void respond({
            protocolVersion: "2025-11-25",
            capabilities: { ...(state.names.length ? { tools: {} } : {}), resources: {} },
            serverInfo: { name, version: "1" },
            instructions: `${name} instructions`,
          });
        if (message.method === "tools/list")
          void respond({
            tools: state.names.map((name) => ({
              name,
              inputSchema: { type: "object", additionalProperties: false },
            })),
          });
        if (message.method === "resources/list") void respond({ resources: [] });
        if (message.method === "tools/call") {
          const tool = (message.params as { name: string }).name;
          state.calls.push(tool);
          void respond({ content: [{ type: "text", text: `${name}/${tool}` }] });
        }
      });
      void server.start();
      return okAsync(client);
    },
  };
}
const unavailable = (name: string) => ({
  name,
  status: "unavailable",
  error: { code: "unavailable", message: "MCP server unavailable" },
});

async function invoke(catalog: CallableCatalog, name: string, args: unknown = {}) {
  return (
    await catalog.invoke(name, args, {} as ToolExecutionApi, BACKGROUND_CONTEXT)
  )._unsafeUnwrap();
}

it.each([
  ["prod-us", "delete", "prod_us", ["delete"], "mcp__prod_us__delete"],
  ["prod_us", "delete", "prod-us", ["delete"], "mcp__prod_us__delete"],
  ["prod", "db__delete", "prod__db", ["delete"], "mcp__prod__db__delete"],
  ["prod__db", "delete", "prod", ["db__delete"], "mcp__prod__db__delete"],
  ["first", "ping", "bad", ["get-user", "get_user"], "mcp__first__ping"],
  ["first", "ping", "bad", ["get_user", "get-user"], "mcp__first__ping"],
  ["first", "ping", "bad", ["same", "same"], "mcp__first__ping"],
] as const)(
  "keeps %s/%s and rejects the entire %s batch %s",
  async (a, toolA, b, batch, scriptName) => {
    const first = endpoint(a, [toolA]);
    const later = endpoint(b, ["unique", ...batch]);
    const healthy = endpoint("healthy", ["ping"]);
    const catalog = new CallableCatalog([]);
    const edges: McpServerStatus[] = [];
    const mcp = new McpTools([first, later, healthy], catalog, undefined, (status) => {
      edges.push(status);
      return okAsync(undefined);
    });
    let native: Awaited<ReturnType<typeof openCodemodeHarness>> | undefined;
    try {
      (await mcp.discover(BACKGROUND_CONTEXT))._unsafeUnwrap();
      // Raw dispatch must not silently select the later endpoint.
      expect.soft((await invoke(catalog, `mcp__${a}__${toolA}`)).isError).toBe(false);
      expect.soft(first.state.calls).toEqual([toolA]);
      expect.soft(later.state.calls).toEqual([]);
      native = await openCodemodeHarness(catalog);
      const textOnly = await native.run('text("hello");');
      expect.soft(textOnly.isError).toBe(false);
      expect.soft(JSON.stringify(textOnly.output)).toContain("hello");
      const called = await native.run(
        `text((await tools.${scriptName}({})).content[0].text); text((await tools.mcp__healthy__ping({})).content[0].text);`,
      );
      expect.soft(called.isError).toBe(false);
      expect.soft(JSON.stringify(called.output)).toContain(`${a}/${toolA}`);
      expect.soft(first.state.calls).toEqual([toolA, toolA]);
      expect.soft(later.state.calls).toEqual([]);
      expect.soft(healthy.state.calls).toEqual(["ping"]);
      expect
        .soft(
          catalog
            .definitions()
            .map((tool) => tool.name)
            .filter((name) => name.startsWith("mcp__")),
        )
        .toEqual([`mcp__${a}__${toolA}`, "mcp__healthy__ping"]);
      expect
        .soft(mcp.status())
        .toEqual([
          { name: a, status: "available" },
          unavailable(b),
          { name: "healthy", status: "available" },
        ]);
      expect.soft(edges).toEqual(mcp.status());
      expect
        .soft(catalog.namespaceValues().find((namespace) => namespace.name === `mcp__${b}`))
        .toEqual({
          name: `mcp__${b}`,
          description: `${b}: unavailable`,
        });
      // Rejected resource-capable endpoints must not publish resource access either.
      expect.soft((await invoke(catalog, "list_mcp_resources", { server: b })).isError).toBe(true);
    } finally {
      await native?.close();
      await mcp.close();
    }
  },
);

it.each([
  ["exact", ["get-user"], true],
  ["alias", ["unique", "get_user"], false],
  ["duplicate", ["unique", "get-user", "get-user"], false],
] as const)("rediscovery preserves retained ownership: %s", async (_label, names, accepted) => {
  const server = endpoint("retry", ["get-user"]);
  const catalog = new CallableCatalog([]);
  const mcp = new McpTools([server], catalog);
  let native: Awaited<ReturnType<typeof openCodemodeHarness>> | undefined;
  try {
    (await mcp.discover(BACKGROUND_CONTEXT))._unsafeUnwrap();
    const incumbent = catalog.definitions().find((tool) => tool.name === "mcp__retry__get-user");
    server.state.fail = true;
    expect((await invoke(catalog, "mcp__retry__get-user")).isError).toBe(true);
    expect(mcp.status()).toEqual([unavailable("retry")]);
    server.state.fail = false;
    server.state.names = [...names];
    (await mcp.discover(BACKGROUND_CONTEXT))._unsafeUnwrap();
    expect
      .soft(mcp.status())
      .toEqual([accepted ? { name: "retry", status: "available" } : unavailable("retry")]);
    const retained = catalog.definitions().filter((tool) => tool.name.startsWith("mcp__retry__"));
    expect.soft(retained.map((tool) => tool.name)).toEqual(["mcp__retry__get-user"]);
    if (!accepted) expect.soft(retained).toEqual([incumbent]);
    native = await openCodemodeHarness(catalog);
    const result = await native.run(
      'text("hello"); text((await tools.mcp__retry__get_user({})).content[0].text);',
    );
    expect.soft(result.isError).toBe(false);
    expect.soft(JSON.stringify(result.output)).toContain("retry/get-user");
    expect.soft(server.state.calls).toEqual(["get-user"]);
    server.state.names = ["get-user"];
    (await mcp.discover(BACKGROUND_CONTEXT))._unsafeUnwrap();
    expect.soft(mcp.status()).toEqual([{ name: "retry", status: "available" }]);
  } finally {
    await native?.close();
    await mcp.close();
  }
});

it.each(["mcp__local__get_user", "mcp__local__get-user"])(
  "preserves hidden local incumbent %s and permits a corrected retry",
  async (name) => {
    let calls = 0;
    const local = defineTool({
      name,
      description: "local incumbent",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async () => {
        calls++;
        return { output: [{ type: "text" as const, text: "local" }] };
      },
    });
    const all = new CallableCatalog([local]);
    all.metadata(name, { deferred: true });
    const server = endpoint("local", ["unique", "get_user"]);
    const mcp = new McpTools([server], all.without([name]));
    try {
      (await mcp.discover(BACKGROUND_CONTEXT))._unsafeUnwrap();
      expect.soft(mcp.status()).toEqual([unavailable("local")]);
      expect.soft(all.definitions()).toEqual([local]);
      expect.soft(all.metadata(name)).toEqual({ deferred: true });
      await invoke(all, name);
      expect.soft(calls).toBe(1);
      expect.soft(server.state.calls).toEqual([]);
      server.state.names = ["unique", "corrected"];
      (await mcp.discover(BACKGROUND_CONTEXT))._unsafeUnwrap();
      expect.soft(mcp.status()).toEqual([{ name: "local", status: "available" }]);
      await invoke(all, "mcp__local__corrected");
      expect.soft(server.state.calls).toEqual(["corrected"]);
      expect.soft(all.definitions().find((tool) => tool.name === name)).toBe(local);
    } finally {
      await mcp.close();
    }
  },
);

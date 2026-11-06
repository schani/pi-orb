import type { McpConfig } from "@pi-orb/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { checkMcp, probeMcp } from "./mcp-probe.ts";

const config: McpConfig = {
  name: "fixture",
  description: "Fixture",
  url: "https://mcp.example/mcp",
  headers: { "X-Key": { secret: "KEY" }, "X-Project": { literal: "fixture" } },
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function mockServer(options: { rejectList?: boolean; status?: number; noTools?: boolean } = {}) {
  const methods: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    expect(init?.redirect).toBe("error");
    expect(init).toHaveProperty("dispatcher");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init?.headers).get("x-key")).toBe("PRIVATE_KEY");
    if (options.status)
      return new Response("PRIVATE_REMOTE_ERROR", {
        status: options.status,
        headers: { "www-authenticate": 'Bearer resource_metadata="https://attacker.example"' },
      });
    if (init?.method !== "POST") return new Response(null, { status: 405 });
    const message = JSON.parse(String(init.body));
    methods.push(message.method);
    if (message.id === undefined) return new Response(null, { status: 202 });
    const payload =
      message.method === "initialize"
        ? {
            protocolVersion: message.params.protocolVersion,
            capabilities: options.noTools ? { resources: {} } : { tools: {} },
            serverInfo: { name: "fixture", version: "1", description: "Fixture description" },
          }
        : { tools: [] };
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        ...(message.method === "server/discover"
          ? { error: { code: -32601, message: "Not found" } }
          : message.method === "tools/list" && options.rejectList
            ? { error: { code: -32603, message: "PRIVATE_REMOTE_ERROR" } }
            : { result: payload }),
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fetcher);
  return { fetcher, methods };
}

it("initializes and lists tools using saved headers and broker Bearer; never calls a tool", async () => {
  const f = mockServer();
  expect((await checkMcp(config, { KEY: "PRIVATE_KEY" }, "PRIVATE_ACCESS")).isOk()).toBe(true);
  expect(f.methods).toEqual([
    "server/discover",
    "initialize",
    "notifications/initialized",
    "tools/list",
  ]);
  for (const [url, init] of f.fetcher.mock.calls) {
    expect(String(url)).toBe(config.url);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer PRIVATE_ACCESS");
  }
});

it("preserves the description probe initialize-only contract", async () => {
  const f = mockServer();
  expect((await probeMcp(config, { KEY: "PRIVATE_KEY" }))._unsafeUnwrap()).toEqual({
    description: "Fixture description",
  });
  expect(f.methods).toEqual(["server/discover", "initialize", "notifications/initialized"]);
});

it.each([401, 403, 500])(
  "sanitizes HTTP %s and never follows challenge metadata",
  async (status) => {
    const f = mockServer({ status });
    expect((await checkMcp(config, { KEY: "PRIVATE_KEY" }))._unsafeUnwrapErr()).toEqual({
      type: "mcp_probe_error",
      diagnostic: status === 401 ? "auth_required" : "connection_failed",
    });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  },
);

it("does not mistake initialize success for successful tools/list", async () => {
  const f = mockServer({ rejectList: true });
  expect((await checkMcp(config, { KEY: "PRIVATE_KEY" }))._unsafeUnwrapErr()).toEqual({
    type: "mcp_probe_error",
    diagnostic: "connection_failed",
  });
  expect(f.methods).toContain("tools/list");
  expect(f.methods).not.toContain("tools/call");
});

it("rejects unsafe URLs and missing bindings before any network", async () => {
  const f = mockServer();
  for (const [value, secrets] of [
    [{ ...config, url: "https://127.0.0.1/mcp" }, { KEY: "PRIVATE_KEY" }],
    [{ ...config, url: "http://mcp.example/mcp" }, { KEY: "PRIVATE_KEY" }],
    [config, {}],
    [config, { KEY: "invalid\r\nheader" }],
  ] as const)
    expect((await checkMcp(value, secrets))._unsafeUnwrapErr()).toEqual({
      type: "mcp_probe_error",
      diagnostic: "invalid_binding",
    });
  expect(f.fetcher).not.toHaveBeenCalled();
});

it("shares one deadline across initialize/list and aborts transport on cleanup", async () => {
  const controller = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  const f = mockServer();
  const serve = f.fetcher.getMockImplementation();
  if (!serve) throw new Error("Missing fixture fetch");
  let started: (() => void) | undefined;
  const listing = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.fetcher.mockImplementation(async (url, init) => {
    if (init?.method === "POST" && JSON.parse(String(init.body)).method === "tools/list") {
      started?.();
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("fixture aborted")), {
          once: true,
        });
      });
    }
    return serve(url, init);
  });
  try {
    const pending = checkMcp(config, { KEY: "PRIVATE_KEY" });
    await listing;
    expect(timeout).toHaveBeenCalledExactlyOnceWith(10_000);
    controller.abort();
    expect((await pending)._unsafeUnwrapErr()).toEqual({
      type: "mcp_probe_error",
      diagnostic: "connection_failed",
    });
    expect(f.fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  } finally {
    timeout.mockRestore();
  }
});

it("accepts initialize-only connectivity for a resource-only server", async () => {
  const f = mockServer({ noTools: true, rejectList: true });
  expect((await checkMcp(config, { KEY: "PRIVATE_KEY" })).isOk()).toBe(true);
  expect(f.methods).toEqual(["server/discover", "initialize", "notifications/initialized"]);
});

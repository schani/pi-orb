import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpConfig } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { createClaudeMcp } from "./mcp.ts";

const config: McpConfig = {
  name: "example",
  url: "https://example.test/mcp",
  description: "test",
  headers: { Authorization: { secret: "KEY", prefix: "Bearer " } },
};
const task = new NoSimulationTask("claude-mcp-test", false);
const broker = { controlPlaneUrl: "https://broker.test", runtimeToken: "runtime" };

describe("Claude project MCP", () => {
  it("maps static headers to the public native HTTP configuration", async () => {
    const result = createClaudeMcp({
      configs: [config],
      secrets: { KEY: "static-test" },
      broker,
      task,
    });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value.mcpServers).toEqual({
      example: { type: "http", url: config.url, headers: { Authorization: "Bearer static-test" } },
    });
    expect((await result.value.close()).isOk()).toBe(true);
  });
  it("rejects invalid bindings without leaking secret contents", () => {
    const result = createClaudeMcp({
      configs: [config],
      secrets: { KEY: "private\r\nsecret" },
      broker,
      task,
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(JSON.stringify(result.error)).not.toContain("private");
  });
  it("preserves raw input schemas and awaits owned request cleanup", async () => {
    const upstream = new Client({ name: "fake", version: "1" });
    vi.spyOn(upstream, "connect").mockResolvedValue();
    const raw = {
      tools: [
        {
          name: "read",
          inputSchema: {
            type: "object",
            properties: { mode: { oneOf: [{ const: "a" }, { const: "b" }] } },
            required: ["mode"],
            additionalProperties: false,
          },
        },
      ],
    };
    vi.spyOn(upstream, "request").mockResolvedValue(raw);
    const closed = vi.spyOn(upstream, "close").mockResolvedValue();
    const result = createClaudeMcp({
      configs: [{ ...config, headers: {}, oauth: { id: "test" } }],
      secrets: {},
      broker,
      task,
      clientFactory: () => upstream,
    });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    const entry = result.value.mcpServers.example;
    expect(entry?.type).toBe("sdk");
    if (entry?.type !== "sdk") return;
    const [host, server] = InMemoryTransport.createLinkedPair();
    await entry.instance.connect(server);
    const consumer = new Client({ name: "consumer", version: "1" });
    await consumer.connect(host);
    expect(await consumer.request({ method: "tools/list" }, ListToolsResultSchema)).toEqual(raw);
    expect((await result.value.close()).isOk()).toBe(true);
    expect(closed).toHaveBeenCalledOnce();
    await consumer.close();
  });
  it("resolves OAuth at each HTTP request and publishes safe auth edges", async () => {
    let now = 0;
    const clock = new NoSimulationTask("claude-mcp-clock", false);
    vi.spyOn(clock, "wallNow").mockImplementation(() => now);
    let generation = 0;
    const endpoint = {
      request: vi.fn(async () =>
        ok({ accessToken: `token-${++generation}`, generation, expiresAt: now + 60_000 }),
      ),
    };
    const seen: string[] = [];
    const states: unknown[] = [];
    let requestFetch: typeof fetch | undefined;
    const client = new Client({ name: "fake", version: "1" });
    const result = createClaudeMcp({
      configs: [{ ...config, headers: {}, oauth: { id: "test" } }],
      secrets: {},
      broker,
      task: clock,
      tokenEndpoint: () => endpoint,
      clientFactory: (_config, fetcher) => {
        requestFetch = fetcher;
        return client;
      },
      fetcher: async (_input, init) => {
        seen.push(new Headers(init?.headers).get("authorization") ?? "");
        return new Response("", { status: 200 });
      },
      onState: (state) => states.push(state),
    });
    expect(result.isOk()).toBe(true);
    expect(requestFetch).toBeDefined();
    if (result.isErr() || requestFetch === undefined) return;
    await requestFetch(config.url, { method: "POST" });
    now = 40_000;
    await requestFetch(config.url, { method: "POST" });
    expect(seen).toEqual(["Bearer token-1", "Bearer token-2"]);
    expect(states).toEqual([]);
    await result.value.close();
  });
  it("retains auth-required edges, sanitizes errors and never replays lost requests", async () => {
    let requestFetch: typeof fetch | undefined;
    const states: unknown[] = [];
    const endpoint = {
      request: vi.fn(async () =>
        ok({ accessToken: "private-token", generation: 1, expiresAt: task.wallNow() + 60_000 }),
      ),
    };
    const network = vi.fn(async () => new Response("private-remote-error", { status: 401 }));
    const result = createClaudeMcp({
      configs: [{ ...config, headers: {}, oauth: { id: "test" } }],
      secrets: {},
      broker,
      task,
      tokenEndpoint: () => endpoint,
      fetcher: network,
      onState: (state) => states.push(state),
      clientFactory: (_config, fetcher) => {
        requestFetch = fetcher;
        return new Client({ name: "fake", version: "1" });
      },
    });
    expect(result.isOk()).toBe(true);
    expect(requestFetch).toBeDefined();
    if (result.isErr() || requestFetch === undefined) return;
    const response = await requestFetch(config.url, { method: "POST" });
    expect(await response.text()).toBe("MCP upstream request failed");
    expect(network).toHaveBeenCalledOnce();
    expect(states).toMatchObject([{ state: "needs-auth", diagnostic: { code: "auth_required" } }]);
    expect(JSON.stringify(states)).not.toContain("private");
    await result.value.close();
  });
  it("close drains an admitted call and rejects subsequent requests", async () => {
    const upstream = new Client({ name: "fake", version: "1" });
    vi.spyOn(upstream, "connect").mockResolvedValue();
    let admitted!: () => void;
    const started = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    let finish!: (value: { tools: [] }) => void;
    vi.spyOn(upstream, "request").mockImplementation(async () => {
      admitted();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    vi.spyOn(upstream, "close").mockImplementation(async () => {
      finish({ tools: [] });
    });
    const result = createClaudeMcp({
      configs: [{ ...config, headers: {}, oauth: { id: "test" } }],
      secrets: {},
      broker,
      task,
      clientFactory: () => upstream,
    });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    const entry = result.value.mcpServers.example;
    expect(entry?.type).toBe("sdk");
    if (entry?.type !== "sdk") return;
    const [host, server] = InMemoryTransport.createLinkedPair();
    await entry.instance.connect(server);
    const consumer = new Client({ name: "consumer", version: "1" });
    await consumer.connect(host);
    const request = consumer.request({ method: "tools/list" }, ListToolsResultSchema).then(
      () => "completed",
      () => "closed",
    );
    await started;
    expect((await result.value.close()).isOk()).toBe(true);
    await request;
    expect((await result.value.close()).isOk()).toBe(true);
    expect(upstream.close).toHaveBeenCalledOnce();
    await expect(
      consumer.request({ method: "tools/list" }, ListToolsResultSchema),
    ).rejects.toThrow();
    expect(upstream.request).toHaveBeenCalledOnce();
    await consumer.close();
  });
});

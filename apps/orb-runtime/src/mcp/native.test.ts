import { NoSimulationTask } from "determined";
import { err, ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { createMcpStateReporter, createNativeMcpFetch, nativeMcpConfig } from "./native.ts";
import { McpCredentialResolver } from "./oauth.ts";

const task = new NoSimulationTask("native-mcp", false);
const config = {
  name: "example",
  description: "Example",
  url: "https://example.org/mcp",
  headers: { "X-Static": { literal: "approved" } },
  oauth: { id: "a6d64347-a9e5-4cda-94ad-f0fd54061271" },
} as const;

it("catalog remains codemode-only and never supplies native guest OAuth", () => {
  const loaded = nativeMcpConfig([config]);
  expect(loaded.servers).toHaveLength(1);
  expect(loaded.servers[0]?.config).toMatchObject({
    url: config.url,
    exposure: "codemode",
    headers: { Authorization: "pi-orb-broker" },
  });
});

it("coalesces native failure edges and records recovery, without healthy startup noise", () => {
  const events: unknown[] = [];
  const report = createMcpStateReporter((event) => events.push(event));
  report("fixture", "connected");
  report("fixture", "failed", "MCP fixture unavailable", {
    code: "upstream_http",
    httpStatus: 503,
  });
  report("fixture", "failed", "MCP fixture unavailable");
  report("fixture", "connected");
  expect(events).toEqual([
    {
      server: "fixture",
      state: "failed",
      message: "MCP fixture unavailable",
      diagnostic: { code: "upstream_http", httpStatus: 503 },
    },
    { server: "fixture", state: "connected" },
  ]);
});

it("state reporter attaches only an explicit source session ID", () => {
  const events: unknown[] = [];
  const report = createMcpStateReporter(
    (event) => events.push(event),
    () => "pi-session",
  );
  report("fixture", "failed", "MCP fixture unavailable", { code: "network" });
  expect(events).toEqual([
    {
      server: "fixture",
      sessionId: "pi-session",
      state: "failed",
      message: "MCP fixture unavailable",
      diagnostic: { code: "network" },
    },
  ]);
});

describe("native request boundary", () => {
  it("injects current broker generation and static headers on each request; never follows redirects or leaks bodies", async () => {
    const attempts: RequestInit[] = [];
    const diagnostics: unknown[] = [];
    let generation = 0;
    const resolver = new McpCredentialResolver({
      request: async () =>
        ok({
          accessToken: `private-${++generation}`,
          generation,
          expiresAt: task.wallNow() + 100_000,
        }),
    });
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      attempts.push(init ?? {});
      return new Response("PRIVATE_REMOTE_BODY", {
        status: 403,
        headers: {
          "www-authenticate":
            'Bearer realm="fixture", error="insufficient_scope", scope="PRIVATE_SCOPE"',
        },
      });
    });
    const request = createNativeMcpFetch({
      config,
      headers: { "X-Static": "approved" },
      resolver,
      task,
      fetcher,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const first = await request(config.url, {
      method: "POST",
      headers: { "X-Request": "present" },
      signal: new AbortController().signal,
    });
    expect(first.status).toBe(403);
    expect(diagnostics).toEqual([{ code: "upstream_http", httpStatus: 403 }]);
    expect(await first.text()).not.toContain("PRIVATE_REMOTE_BODY");
    expect(first.headers.get("www-authenticate")).toContain("insufficient_scope");
    expect(first.headers.get("www-authenticate")).toContain("PRIVATE_SCOPE");
    expect(attempts[0]?.redirect).toBe("error");
    expect(new Headers(attempts[0]?.headers).get("Authorization")).toBe("Bearer private-1");
    expect(new Headers(attempts[0]?.headers).get("X-Static")).toBe("approved");
    expect(JSON.stringify(attempts)).not.toContain("pi-orb-broker");
    resolver.rejected(1);
    await request(config.url, { method: "GET" });
    expect(new Headers(attempts[1]?.headers).get("Authorization")).toBe("Bearer private-2");
  });

  it("rejects malformed static header values before network dispatch", async () => {
    const diagnostics: unknown[] = [];
    const fetcher = vi.fn();
    const request = createNativeMcpFetch({
      config,
      headers: { "X-Static": "invalid\0value" },
      task,
      fetcher,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    await expect(request(config.url, {})).rejects.toThrow("MCP example request headers invalid");
    expect(fetcher).not.toHaveBeenCalled();
    expect(diagnostics).toEqual([{ code: "invalid_binding" }]);
  });

  it("maps synchronous platform fetch failures without exposing their cause", async () => {
    const request = createNativeMcpFetch({
      config,
      headers: {},
      task,
      fetcher: () => {
        throw new Error("PRIVATE_FETCH_ERROR");
      },
    });
    await expect(request(config.url, {})).rejects.toThrow("MCP example upstream unavailable");
  });

  it("sanitizes an upstream 304 without allowing Response construction to throw raw", async () => {
    const request = createNativeMcpFetch({
      config,
      headers: {},
      task,
      fetcher: async () => new Response(null, { status: 304 }),
    });
    const result = await request(config.url, { method: "POST" });
    expect(result.status).toBe(502);
    expect(await result.text()).toBe("MCP upstream request failed");
  });

  it("does not diagnose expected GET 405 or cleanup DELETE 404", async () => {
    const diagnostics: unknown[] = [];
    const fetcher = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        new Response("PRIVATE_RESPONSE_BODY", { status: init?.method === "GET" ? 405 : 404 }),
    );
    const request = createNativeMcpFetch({
      config,
      headers: {},
      task,
      fetcher,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    await request(config.url, { method: "GET" });
    await request(config.url, { method: "DELETE" });
    expect(diagnostics).toEqual([]);
  });

  it("marks only the exact rejected 401 generation and obtains the next broker token", async () => {
    const rejected: (number | undefined)[] = [];
    let generation = 0;
    const resolver = new McpCredentialResolver({
      request: async (_task, _signal, rejectedGeneration) => {
        rejected.push(rejectedGeneration);
        generation++;
        return ok({
          accessToken: `private-${generation}`,
          generation,
          expiresAt: task.wallNow() + 100_000,
        });
      },
    });
    const fetcher = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response("PRIVATE_RESPONSE_BODY", { status: 401 }),
    );
    const request = createNativeMcpFetch({ config, headers: {}, resolver, task, fetcher });
    expect((await request(config.url, {})).status).toBe(401);
    expect((await request(config.url, {})).status).toBe(401);
    expect(rejected).toEqual([undefined, 1]);
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer private-1",
    );
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer private-2",
    );
  });

  it("classifies broker failures by typed code, never by message wording", async () => {
    const diagnostics: unknown[] = [];
    const resolver = new McpCredentialResolver({
      request: async () =>
        err({
          type: "mcp_error" as const,
          code: "unavailable" as const,
          message: "authorization required is only an incidental error detail",
        }),
    });
    const request = createNativeMcpFetch({
      config,
      headers: {},
      resolver,
      task,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    await expect(request(config.url, {})).rejects.toThrow();
    expect(diagnostics).toEqual([{ code: "broker_unavailable" }]);
  });

  it("cancellation and failed broker result never send a request", async () => {
    const fetcher = vi.fn();
    const resolver = new McpCredentialResolver({
      request: async () =>
        err({
          type: "mcp_error" as const,
          code: "unavailable" as const,
          message: "MCP token unavailable",
        }),
    });
    const request = createNativeMcpFetch({ config, headers: {}, resolver, task, fetcher });
    await expect(request(config.url, {})).rejects.toThrow("MCP token unavailable");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

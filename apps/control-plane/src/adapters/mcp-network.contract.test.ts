import type { LookupAddress } from "node:dns";
import { once } from "node:events";
import { createServer } from "node:http";
import { Agent } from "undici";
import { afterEach, expect, it, vi } from "vitest";
import { createMcpOAuthFetch } from "./mcp-oauth.ts";
import { checkMcp, probeMcp } from "./mcp-probe.ts";

const dnsLookup = vi.hoisted(() =>
  vi.fn<
    (
      hostname: string,
      options: { all: true },
      callback: (error: Error | null, addresses: LookupAddress[]) => void,
    ) => void
  >(),
);
vi.mock("node:dns", () => ({ lookup: dnsLookup }));
afterEach(() => dnsLookup.mockReset());

it.each(
  [
    [],
    [{ address: "127.0.0.1", family: 4 }],
    [{ address: "169.254.169.254", family: 4 }],
    [{ address: "::ffff:127.0.0.1", family: 6 }],
    [
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ],
  ].map((addresses) => ({ addresses })),
)("rejects socket-time DNS answers $addresses in OAuth and probe", async ({ addresses }) => {
  // Only DNS is substituted: native fetch must dispatch through the real npm Agent.
  dnsLookup.mockImplementation((_hostname, _options, callback) => callback(null, addresses));
  const network = createMcpOAuthFetch();
  try {
    await expect(network.fetcher("https://mcp.example/token")).rejects.toMatchObject({
      cause: { message: "OAuth DNS rejected" },
    });
    const result = await probeMcp(
      {
        name: "fixture",
        description: "",
        url: "https://mcp.example/mcp",
        headers: {},
      },
      {},
    );
    expect(result.isErr()).toBe(true);
    expect(result.isErr() && result.error).toBe(
      "Cannot connect to MCP; check endpoint and project secret bindings",
    );
    const health = await checkMcp(
      {
        name: "fixture",
        description: "Fixture",
        url: "https://mcp.example/mcp",
        headers: {},
      },
      {},
    );
    expect(health._unsafeUnwrapErr()).toEqual({
      type: "mcp_probe_error",
      diagnostic: "invalid_binding",
    });
    expect(dnsLookup).toHaveBeenCalledTimes(3);
    expect(dnsLookup).toHaveBeenNthCalledWith(
      1,
      "mcp.example",
      { all: true },
      expect.any(Function),
    );
  } finally {
    await network.close();
  }
});

it("native fetch interoperates with the npm Agent for keepalive, redirects and abort", async () => {
  const requests: string[] = [];
  const sockets = new Set();
  const server = createServer((request, reply) => {
    requests.push(request.url ?? "");
    sockets.add(request.socket);
    if (request.url === "/redirect") {
      reply.writeHead(307, { location: "/credential-leak" }).end();
    } else if (request.url === "/abort") {
      reply.writeHead(200).flushHeaders();
    } else {
      reply.end("ok");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const origin = `http://127.0.0.1:${address.port}`;
  const agent = new Agent({ connections: 1 });
  const send = (path: string, init: RequestInit = {}) =>
    fetch(`${origin}${path}`, { ...init, dispatcher: agent } as RequestInit & {
      dispatcher: Agent;
    });
  try {
    for (let index = 0; index < 2; index++) expect(await (await send("/ok")).text()).toBe("ok");
    expect(sockets.size).toBe(1);
    await expect(
      send("/redirect", {
        method: "POST",
        headers: { authorization: "Bearer MOCK_SECRET" },
        body: "refresh_token=MOCK_REFRESH",
        redirect: "error",
      }),
    ).rejects.toThrow();
    expect(requests).toEqual(["/ok", "/ok", "/redirect"]);
    const controller = new AbortController();
    const response = await send("/abort", { signal: controller.signal });
    const body = response.text();
    controller.abort();
    await expect(body).rejects.toThrow();
  } finally {
    await agent.destroy();
    server.closeAllConnections();
    const closed = once(server, "close");
    server.close();
    await closed;
  }
});

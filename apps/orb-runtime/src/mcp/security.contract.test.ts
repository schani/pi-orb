import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { NoSimulationTask } from "determined";
import { ok } from "neverthrow";
import { expect, it } from "vitest";
import { McpCredentialResolver } from "./oauth.ts";
import { createBrokerMcpFetch } from "./transport.ts";

it("keeps Claude MCP broker credentials on the approved URL despite a malicious OAuth challenge", async () => {
  const task = new NoSimulationTask("mcp-security", false);
  const url = "https://mcp.example/mcp";
  const requests: string[] = [];
  const diagnostics: unknown[] = [];
  let generation = 0;
  const fetcher = createBrokerMcpFetch({
    config: {
      name: "mock",
      description: "mock",
      url,
      headers: {},
      oauth: { id: "10000000-0000-4000-8000-000000000001" },
    },
    headers: {},
    task,
    resolver: new McpCredentialResolver({
      request: async () =>
        ok({
          accessToken: "MOCK_ACCESS_SENTINEL",
          generation: ++generation,
          expiresAt: task.wallNow() + 100_000,
        }),
    }),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    fetcher: async (input, init) => {
      requests.push(String(input));
      expect(String(input)).toBe(url);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer MOCK_ACCESS_SENTINEL");
      expect(init?.redirect).toBe("error");
      expect(String(init?.body)).not.toContain("MOCK_ACCESS_SENTINEL");
      return new Response("MOCK_PRIVATE_REMOTE_BODY", {
        status: 401,
        headers: {
          "www-authenticate": 'Bearer resource_metadata="https://attacker.example/metadata"',
        },
      });
    },
  });
  const client = new Client({ name: "mock", version: "1" });
  try {
    await expect(
      client.connect(
        new StreamableHTTPClientTransport(new URL(url), { fetch: fetcher }) as Parameters<
          Client["connect"]
        >[0],
      ),
    ).rejects.toThrow();
    expect(requests).toEqual([url]);
    expect(generation).toBe(1);
    expect(diagnostics).toEqual([{ code: "upstream_http", httpStatus: 401 }]);
    expect(JSON.stringify(diagnostics)).not.toContain("SENTINEL");
    expect(JSON.stringify(diagnostics)).not.toContain("MOCK_PRIVATE_REMOTE_BODY");
  } finally {
    await client.close();
  }
});

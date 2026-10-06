import { McpClient } from "@earendil-works/pi-mcp";
import { NoSimulationTask } from "determined";
import { ok } from "neverthrow";
import { expect, it } from "vitest";
import { createNativeMcpTransport } from "./native.ts";
import { McpCredentialResolver } from "./oauth.ts";

it("native broker transport ignores a malicious authorization-server challenge", async () => {
  const task = new NoSimulationTask("mcp-security", false);
  const url = "https://mcp.example/mcp";
  const requests: string[] = [];
  const diagnostics: unknown[] = [];
  let generation = 0;
  const resolver = new McpCredentialResolver({
    request: async () =>
      ok({
        accessToken: "MOCK_ACCESS_SENTINEL",
        generation: ++generation,
        expiresAt: task.wallNow() + 100_000,
      }),
  });
  const transport = createNativeMcpTransport({
    config: {
      name: "mock",
      description: "mock",
      url,
      headers: {},
      oauth: { id: "10000000-0000-4000-8000-000000000001" },
    },
    headers: {},
    resolver,
    task,
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
  const client = new McpClient({ name: "mock", version: "1" });
  try {
    await expect(client.connect(transport)).rejects.toThrow();
    expect(requests).toEqual([url, url]);
    expect(generation).toBe(2);
    expect(diagnostics).toEqual([
      { code: "upstream_http", httpStatus: 401 },
      { code: "upstream_http", httpStatus: 401 },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("SENTINEL");
    expect(JSON.stringify(diagnostics)).not.toContain("MOCK_PRIVATE_REMOTE_BODY");
  } finally {
    await client.close();
  }
});

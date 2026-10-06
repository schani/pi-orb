import {
  auth,
  Client,
  fetchToken,
  type OAuthClientProvider,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { OAuthClientInformationFullSchema, OAuthTokensSchema } from "@modelcontextprotocol/core";
import { describe, expect, it } from "vitest";

// SDK contract only: production uses persisted-context exchange/refresh, not fetchToken.
describe("MCP OAuth issuer binding (GHSA-6qxp-vccf-f47h)", () => {
  it("rejects another issuer before posting stamped client credentials", async () => {
    const issuer = "https://trusted.example";
    const attacker = "https://attacker.example";
    const requests: string[] = [];
    const provider: OAuthClientProvider = {
      redirectUrl: undefined,
      clientMetadata: { redirect_uris: [], grant_types: ["client_credentials"] },
      clientInformation: () => ({
        client_id: "mock-client",
        client_secret: "MOCK_CLIENT_SECRET_SENTINEL",
        issuer,
      }),
      prepareTokenRequest: () => new URLSearchParams({ grant_type: "client_credentials" }),
      tokens: () => undefined,
      saveTokens: () => undefined,
      redirectToAuthorization: () => undefined,
      saveCodeVerifier: () => undefined,
      codeVerifier: () => "mock-verifier",
    };
    const result = await fetchToken(provider, attacker, {
      metadata: {
        issuer: attacker,
        authorization_endpoint: `${attacker}/authorize`,
        token_endpoint: `${attacker}/token`,
        response_types_supported: ["code"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
      },
      fetchFn: async (input, init) => {
        requests.push(String(input));
        expect(String(init?.body)).toContain("MOCK_CLIENT_SECRET_SENTINEL");
        return new Response(JSON.stringify({ access_token: "MOCK_ACCESS", token_type: "Bearer" }), {
          headers: { "content-type": "application/json" },
        });
      },
    }).then(
      () => ({ rejected: false }),
      () => ({ rejected: true }),
    );
    expect({ result, requests }).toEqual({ result: { rejected: true }, requests: [] });
  });

  it("probe-style SDK transport without OAuth does not follow challenge metadata", async () => {
    const requests: string[] = [];
    const client = new Client({ name: "mock-probe", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL("https://mcp.example/mcp"), {
      fetch: async (input) => {
        requests.push(String(input));
        return new Response("MOCK_PRIVATE_REMOTE_BODY", {
          status: 401,
          headers: {
            "www-authenticate": 'Bearer resource_metadata="https://attacker.example/metadata"',
          },
        });
      },
    });
    try {
      await expect(client.connect(transport)).rejects.toThrow();
      expect(requests).toEqual(["https://mcp.example/mcp"]);
    } finally {
      await client.close();
    }
  });

  it("does not refresh stamped credentials at an MCP-selected malicious issuer", async () => {
    const attacker = "https://attacker.example";
    const requests: string[] = [];
    const provider: OAuthClientProvider = {
      redirectUrl: "https://orb.example/callback",
      clientMetadata: { redirect_uris: ["https://orb.example/callback"] },
      clientInformation: () => ({ client_id: "mock-client", issuer: attacker }),
      tokens: () => ({
        access_token: "MOCK_ACCESS",
        refresh_token: "MOCK_REFRESH_SENTINEL",
        token_type: "Bearer",
        issuer: "https://trusted.example",
      }),
      saveTokens: () => undefined,
      redirectToAuthorization: () => undefined,
      saveCodeVerifier: () => undefined,
      codeVerifier: () => "mock-verifier",
    };
    await auth(provider, {
      serverUrl: "https://mcp.example/mcp",
      resourceMetadataUrl: new URL("https://mcp.example/changed-metadata"),
      fetchFn: async (input, init) => {
        const url = String(input);
        requests.push(url);
        if (url === `${attacker}/token`)
          expect(String(init?.body)).toContain("MOCK_REFRESH_SENTINEL");
        const value = url.startsWith(attacker)
          ? url.endsWith("/token")
            ? { access_token: "MOCK_ACCESS", token_type: "Bearer" }
            : {
                issuer: attacker,
                authorization_endpoint: `${attacker}/authorize`,
                token_endpoint: `${attacker}/token`,
                response_types_supported: ["code"],
                code_challenge_methods_supported: ["S256"],
              }
          : { resource: "https://mcp.example/mcp", authorization_servers: [attacker] };
        return new Response(JSON.stringify(value), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    expect(requests).not.toContain(`${attacker}/token`);
    expect(requests).toContain("https://mcp.example/changed-metadata");
  });

  it("aggregates cursorless SDK discovery while retaining explicit-cursor pages", async () => {
    const pages: string[] = [];
    const transport = new StreamableHTTPClientTransport(new URL("https://mcp.example/mcp"), {
      fetch: async (_input, init) => {
        if (init?.method !== "POST") return new Response(null, { status: 405 });
        const message = JSON.parse(String(init.body));
        if (message.id === undefined) return new Response(null, { status: 202 });
        let result: unknown;
        if (message.method === "initialize") {
          result = {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {}, resources: {}, prompts: {} },
            serverInfo: { name: "mock", version: "1" },
          };
        } else {
          const second = message.params?.cursor === "next";
          pages.push(`${message.method}:${second ? "next" : "first"}`);
          const name = second ? "second" : "first";
          result = {
            ...(message.method === "tools/list"
              ? { tools: [{ name, inputSchema: { type: "object" } }] }
              : message.method === "resources/list"
                ? { resources: [{ name, uri: `mock:///${name}` }] }
                : { prompts: [{ name }] }),
            ...(second ? {} : { nextCursor: "next" }),
          };
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    const client = new Client({ name: "mock", version: "1" });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "first",
        "second",
      ]);
      expect((await client.listResources()).resources.map((resource) => resource.name)).toEqual([
        "first",
        "second",
      ]);
      expect((await client.listPrompts()).prompts.map((prompt) => prompt.name)).toEqual([
        "first",
        "second",
      ]);
      expect((await client.listTools({ cursor: "next" })).tools.map((tool) => tool.name)).toEqual([
        "second",
      ]);
      expect(pages).toEqual([
        "tools/list:first",
        "tools/list:next",
        "resources/list:first",
        "resources/list:next",
        "prompts/list:first",
        "prompts/list:next",
        "tools/list:next",
      ]);
    } finally {
      await client.close();
    }
  });

  it("retains issuer stamps across public core-schema storage round trips", () => {
    const issuer = "https://trusted.example";
    const tokens = {
      access_token: "MOCK_ACCESS",
      refresh_token: "MOCK_REFRESH",
      token_type: "Bearer",
      issuer,
    };
    const client = {
      client_id: "mock-client",
      client_secret: "MOCK_SECRET",
      redirect_uris: [],
      issuer,
    };
    expect(OAuthTokensSchema.parse(JSON.parse(JSON.stringify(tokens)))).toEqual(tokens);
    expect(OAuthClientInformationFullSchema.parse(JSON.parse(JSON.stringify(client)))).toEqual(
      client,
    );
  });
});

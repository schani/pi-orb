import { createHash } from "node:crypto";
import { NoSimulationTask } from "determined";
import { describe, expect, it } from "vitest";
import type { StoredMcpOAuth } from "../domain/mcp-oauth.ts";
import { createMcpOAuthFetch, SdkMcpOAuth } from "./mcp-oauth.ts";

const task = new NoSimulationTask("oauth-sdk", false);
for (const provider of ["cloudflare", "datadog"] as const) {
  describe(`${provider} discovery shape (synthetic SDK contract, not provider qualification)`, () => {
    const resource = provider === "cloudflare" ? "https://mcp.example/mcp" : "https://mcp.example";
    const serverUrl = provider === "cloudflare" ? resource : `${resource}/v1/mcp`;
    const issuer = provider === "cloudflare" ? "https://mcp.example" : serverUrl;
    it("registers, binds PKCE/resource/issuer, exchanges and preserves omitted refresh replacement", async () => {
      let challenge = "";
      const grants: string[] = [];
      const fetcher: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        const json = (value: unknown) =>
          new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
        if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
          return json({ resource, authorization_servers: [issuer] });
        if (url.pathname.startsWith("/.well-known/"))
          return json({
            issuer,
            authorization_endpoint: "https://consent.example/authorize",
            token_endpoint: "https://consent.example/token",
            registration_endpoint: "https://consent.example/register",
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            scopes_supported: ["mcp_all"],
            token_endpoint_auth_methods_supported: ["none"],
            authorization_response_iss_parameter_supported: true,
          });
        if (url.pathname === "/register") {
          const metadata = JSON.parse(String(init?.body));
          expect(metadata.redirect_uris).toEqual(["https://orb.example/callback"]);
          return json({
            ...metadata,
            client_id: "test-client",
            client_secret_expires_at: 1900000000,
          });
        }
        expect(url.href).toBe("https://consent.example/token");
        const params = new URLSearchParams(String(init?.body));
        expect(params.get("resource")).toBe(new URL(resource).href);
        expect(params.get("client_id")).toBe("test-client");
        grants.push(params.get("grant_type") ?? "");
        if (params.get("grant_type") === "authorization_code") {
          expect(
            createHash("sha256")
              .update(params.get("code_verifier") ?? "")
              .digest("base64url"),
          ).toBe(challenge);
          expect(params.get("redirect_uri")).toBe("https://orb.example/callback");
          if (params.get("code") === "no-refresh")
            return json({
              access_token: "access-no-refresh",
              token_type: "Bearer",
              expires_in: 120,
            });
          return json({
            access_token: "access-1",
            refresh_token: "refresh-1",
            token_type: "Bearer",
            expires_in: 3600,
          });
        }
        expect(params.get("refresh_token")).toBe("refresh-1");
        return grants.length === 2
          ? json({ access_token: "access-2", token_type: "bearer", expires_in: 3600 })
          : json({
              access_token: "access-3",
              refresh_token: "refresh-2",
              token_type: "bearer",
              expires_in: 86400 * 730,
            });
      };
      const sdk = new SdkMcpOAuth("https://orb.example/callback", fetcher);
      const prepared = (
        await sdk.prepare(task, { projectId: "p", id: "c", url: serverUrl }, "opaque-state")
      )._unsafeUnwrap();
      const url = new URL(prepared.url);
      challenge = url.searchParams.get("code_challenge") ?? "";
      expect(challenge).not.toBe("");
      expect(url.searchParams.get("state")).toBe("opaque-state");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(
        (await sdk.exchange(task, prepared.secret, "code", "https://attacker.example")).isErr(),
      ).toBe(true);
      expect(grants).toEqual([]);
      const credential = (
        await sdk.exchange(task, prepared.secret, "code", issuer)
      )._unsafeUnwrap();
      expect(credential.diagnostic).toEqual({
        accessLifetimeSeconds: 3600,
        refreshPresent: true,
        refreshReplaced: true,
        clientExpiry: 1900000000,
      });
      const fresh = (
        await sdk.refresher.refresh(task, credential, { signal: new AbortController().signal })
      )._unsafeUnwrap();
      expect((fresh as typeof credential).diagnostic).toEqual({
        accessLifetimeSeconds: 3600,
        refreshPresent: true,
        refreshReplaced: false,
        clientExpiry: 1900000000,
      });
      expect(fresh.refresh).toBe("refresh-1");
      expect(fresh.access).toBe("access-2");
      const rotated = (
        await sdk.refresher.refresh(task, fresh, {
          signal: new AbortController().signal,
        })
      )._unsafeUnwrap();
      expect(rotated.refresh).toBe("refresh-2");
      expect((rotated as typeof credential).diagnostic).toEqual({
        accessLifetimeSeconds: 86400 * 365,
        refreshPresent: true,
        refreshReplaced: true,
        clientExpiry: 1900000000,
      });
      const absent = (
        await sdk.exchange(task, prepared.secret, "no-refresh", issuer)
      )._unsafeUnwrap();
      expect(absent.refresh).toBe("");
      expect(absent.diagnostic).toEqual({
        accessLifetimeSeconds: 120,
        refreshPresent: false,
        refreshReplaced: false,
        clientExpiry: 1900000000,
      });
      expect(grants).toEqual([
        "authorization_code",
        "refresh_token",
        "refresh_token",
        "authorization_code",
      ]);
    });
  });
}
it.each([
  ["invalid_grant", "invalid_grant", 400],
  ["invalid_client", "invalid_client", 401],
  ["missing_refresh_token", "missing_refresh_token", 0],
  ["unusable_refresh_response", "unusable_refresh_response", 200],
  ["missing_expiry", "unusable_refresh_response", 200],
] as const)("refresh diagnosis %s redacts provider secrets", async (scenario, category, status) => {
  const secret = "SENSITIVE_PROVIDER_BODY_AND_TOKEN";
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
      return json({
        resource: "https://mcp.example/mcp",
        authorization_servers: ["https://mcp.example"],
      });
    if (url.pathname.startsWith("/.well-known/"))
      return json({
        issuer: "https://mcp.example",
        authorization_endpoint: "https://consent.example/authorize",
        token_endpoint: "https://consent.example/token",
        registration_endpoint: "https://consent.example/register",
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      });
    if (url.pathname === "/register")
      return json({
        client_id: "test-client",
        redirect_uris: ["https://orb.example/callback"],
        token_endpoint_auth_method: "none",
      });
    if (scenario === "missing_refresh_token") throw new Error("must not call upstream");
    if (status !== 200) return json({ error: scenario, error_description: secret }, status);
    return json({
      access_token: secret,
      token_type: "Bearer",
      ...(scenario === "missing_expiry" ? {} : { expires_in: 0 }),
      refresh_token: secret,
    });
  };
  const sdk = new SdkMcpOAuth("https://orb.example/callback", fetcher);
  const prepared = (
    await sdk.prepare(task, { projectId: "p", id: "c", url: "https://mcp.example/mcp" }, "state")
  )._unsafeUnwrap();
  const credential = {
    ...prepared.secret,
    access: secret,
    refresh: scenario === "missing_refresh_token" ? "" : secret,
  };
  const result = await sdk.refresher.refresh(task, credential, {
    signal: new AbortController().signal,
  });
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.type).toBe("invalid_grant");
    expect(result.error.diagnostic).toBe(category);
    expect(JSON.stringify(result.error)).not.toContain(secret);
  }
});
it("SDK rejection of malformed HTTP 200 stays transient and is redacted", async () => {
  const secret = "SENSITIVE_PROVIDER_BODY";
  const sdk = new SdkMcpOAuth(
    "https://orb.example/callback",
    async () =>
      new Response(`{${secret}`, { status: 200, headers: { "content-type": "application/json" } }),
  );
  const credential: StoredMcpOAuth = {
    projectId: "p",
    connectionId: "c",
    access: "a",
    refresh: "r",
    accountId: "c",
    expiresAt: 0,
    oauth: {
      issuer: "https://mcp.example",
      metadata: { token_endpoint: "https://mcp.example/token" },
      client: { client_id: "client", token_endpoint_auth_method: "none" },
      resource: "https://mcp.example/mcp",
    },
  };
  const result = await sdk.refresher.refresh(task, credential, {
    signal: new AbortController().signal,
  });
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.type).toBe("upstream_transient");
    expect(result.error.diagnostic).toBe("unusable_refresh_response");
    expect(JSON.stringify(result.error)).not.toContain(secret);
  }
});
it("rejects private metadata/token destinations before connecting", async () => {
  const network = createMcpOAuthFetch();
  try {
    for (const url of [
      "http://public.example/token",
      "https://127.0.0.1/token",
      "https://169.254.169.254/token",
      "https://user:password@example.com/token",
    ]) {
      await expect(network.fetcher(url)).rejects.toThrow("OAuth endpoint rejected");
    }
  } finally {
    await network.close();
  }
});

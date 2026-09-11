import { createHash } from "node:crypto";
import { NoSimulationTask } from "determined";
import { describe, expect, it } from "vitest";
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
          return json({ ...metadata, client_id: "test-client" });
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
          return json({
            access_token: "access-1",
            refresh_token: "refresh-1",
            token_type: "Bearer",
            expires_in: 3600,
          });
        }
        expect(params.get("refresh_token")).toBe("refresh-1");
        return json({ access_token: "access-2", token_type: "bearer", expires_in: 3600 });
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
      const fresh = (
        await sdk.refresher.refresh(task, credential, { signal: new AbortController().signal })
      )._unsafeUnwrap();
      expect(fresh.refresh).toBe("refresh-1");
      expect(fresh.access).toBe("access-2");
      expect(grants).toEqual(["authorization_code", "refresh_token"]);
    });
  });
}
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

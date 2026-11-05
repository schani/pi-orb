import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { OAuth2Client } from "google-auth-library";
import { afterEach, expect, it, vi } from "vitest";

// Exercise the legacy provider's metadata closure, not the control-plane's auth-11 copy.
const metadata = createRequire(import.meta.url)("gcp-metadata") as typeof import("gcp-metadata");
afterEach(() => vi.unstubAllEnvs());

it("Google refresh and legacy metadata retain HTTP headers, bodies and errors", async () => {
  const requests: string[] = [];
  const forms: URLSearchParams[] = [];
  const flavors: Array<string | string[] | undefined> = [];
  const server = createServer(async (request, reply) => {
    requests.push(request.url ?? "");
    if (request.url === "/token") {
      let body = "";
      for await (const chunk of request) body += chunk;
      forms.push(new URLSearchParams(body));
      reply.setHeader("content-type", "application/json");
      reply.end(
        JSON.stringify({ access_token: "MOCK_ACCESS", expires_in: 3600, token_type: "Bearer" }),
      );
    } else {
      flavors.push(request.headers["metadata-flavor"]);
      reply.setHeader("metadata-flavor", "Google");
      if (request.url?.endsWith("/missing")) reply.writeHead(404).end("missing");
      else reply.end("fixture-project");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const origin = `http://127.0.0.1:${address.port}`;
  vi.stubEnv("GCE_METADATA_HOST", origin);
  const client = new OAuth2Client({
    clientId: "client",
    clientSecret: "MOCK_SECRET",
    endpoints: { oauth2TokenUrl: `${origin}/token` },
    transporterOptions: { retry: false, timeout: 5000 },
  });
  client.setCredentials({ refresh_token: "MOCK_REFRESH" });
  try {
    const refreshed = await client.refreshAccessToken();
    expect(refreshed.credentials.access_token).toBe("MOCK_ACCESS");
    expect(refreshed.credentials.refresh_token).toBe("MOCK_REFRESH");
    expect(await metadata.project("project-id")).toBe("fixture-project");
    await expect(metadata.project("missing")).rejects.toMatchObject({ response: { status: 404 } });
    expect(forms.map((form) => Object.fromEntries(form))).toEqual([
      {
        grant_type: "refresh_token",
        refresh_token: "MOCK_REFRESH",
        client_id: "client",
        client_secret: "MOCK_SECRET",
      },
    ]);
    expect(flavors).toEqual(["Google", "Google"]);
    expect(requests).toEqual([
      "/token",
      "/computeMetadata/v1/project/project-id",
      "/computeMetadata/v1/project/missing",
    ]);
  } finally {
    server.closeAllConnections();
    const closed = once(server, "close");
    server.close();
    await closed;
  }
});

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect as expectPage } from "@playwright/test";
import { build } from "vite";
import { expect, it } from "vitest";
import {
  api,
  createFakeSession,
  deleteFakeSession,
  FatalProbeError,
  fakeControl,
  startControlPlane,
  waitFor,
} from "./harness.ts";

it("browser OAuth → two real Pi runtimes reuse the grant → rejection/refresh → reconnect → disconnect", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-orb-oauth-e2e-"));
  const key = join(root, "key.pem");
  const cert = join(root, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-subj",
      "/CN=oauth-fixture",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-days",
      "1",
    ],
    { stdio: "ignore" },
  );
  let origin = "";
  let grant = 0;
  let refreshes = 0;
  let acceptedCalls = 0;
  let rejectAccess = false;
  let rejectRefresh = false;
  const codes = new Map<string, { challenge: string; redirect: string }>();
  const server = createServer(
    { key: readFileSync(key), cert: readFileSync(cert) },
    async (req, res) => {
      const url = new URL(req.url ?? "/", origin);
      const json = (value: unknown, status = 200) =>
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
        return;
      }
      if (url.pathname.startsWith("/.well-known/")) {
        json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          authorization_response_iss_parameter_supported: true,
        });
        return;
      }
      if (url.pathname === "/authorize") {
        const code = randomUUID();
        codes.set(code, {
          challenge: url.searchParams.get("code_challenge") ?? "",
          redirect: url.searchParams.get("redirect_uri") ?? "",
        });
        const callback = new URL(url.searchParams.get("redirect_uri") ?? "");
        callback.searchParams.set("state", url.searchParams.get("state") ?? "");
        callback.searchParams.set("code", code);
        callback.searchParams.set("iss", origin);
        res
          .writeHead(200, { "content-type": "text/html" })
          .end(`<a href="${callback.href.replaceAll("&", "&amp;")}">Authorize fixture</a>`);
        return;
      }
      let raw = "";
      for await (const part of req) raw += part;
      if (url.pathname === "/register") {
        json({ ...JSON.parse(raw), client_id: "fixture-client" });
        return;
      }
      if (url.pathname === "/token") {
        const params = new URLSearchParams(raw);
        if (params.get("grant_type") === "authorization_code") {
          const record = codes.get(params.get("code") ?? "");
          codes.delete(params.get("code") ?? "");
          if (
            !record ||
            record.challenge !==
              createHash("sha256")
                .update(params.get("code_verifier") ?? "")
                .digest("base64url") ||
            record.redirect !== params.get("redirect_uri")
          ) {
            json({ error: "invalid_grant" }, 400);
            return;
          }
          rejectAccess = false;
          rejectRefresh = false;
        } else {
          if (rejectRefresh || params.get("refresh_token") !== `fixture-refresh-${grant}`) {
            json({ error: "invalid_grant" }, 400);
            return;
          }
          refreshes++;
          rejectAccess = false;
        }
        grant++;
        json({
          access_token: `fixture-access-${grant}`,
          refresh_token: `fixture-refresh-${grant}`,
          token_type: "Bearer",
          expires_in: 3600,
        });
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      if (rejectAccess || req.headers.authorization !== `Bearer fixture-access-${grant}`) {
        res.writeHead(401).end();
        return;
      }
      const message = JSON.parse(raw);
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      if (message.method === "tools/call") acceptedCalls++;
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: message.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "OAuth fixture", version: "1" },
            }
          : message.method === "tools/list"
            ? { tools: [{ name: "read", inputSchema: { type: "object" } }] }
            : { content: [{ type: "text", text: "OAUTH_READ_OK" }] };
      json({ jsonrpc: "2.0", id: message.id, result });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("OAuth fixture not listening");
  origin = `https://127.0.0.1:${address.port}`;
  const fake = await createFakeSession(`oauth-${randomUUID()}`, {
    auth: { accountId: "oauth-e2e", device: { manualApprove: true } },
    model: {
      rules: Array.from({ length: 7 }, (_, index) => [
        {
          match: { userMessage: { regex: `^OAuth ${index}$` } },
          steps: [
            {
              type: "toolCall" as const,
              name: "mcp_call",
              arguments: { server: "fixture", tool: "read", args: {} },
            },
            { type: "stop" as const, status: "completed" as const },
          ],
        },
        {
          match: { default: true },
          steps: [
            { type: "text" as const, content: `OAUTH_DONE_${index}` },
            { type: "stop" as const, status: "completed" as const },
          ],
        },
        {
          match: { userMessage: { regex: "^Write a single short desktop-notification sentence" } },
          steps: [
            { type: "text" as const, content: "Checked OAuth." },
            { type: "stop" as const, status: "completed" as const },
          ],
        },
      ]).flat(),
    },
  });
  const names = await createFakeSession(`oauth-names-${randomUUID()}`, {
    model: {
      rules: [0, 1, 2].map(() => ({
        match: { default: true },
        steps: [
          { type: "text" as const, content: "OAuth Test" },
          { type: "stop" as const, status: "completed" as const },
        ],
      })),
    },
  });
  const web = join(import.meta.dirname, "../apps/web");
  await build({
    root: web,
    configFile: join(web, "vite.config.ts"),
    logLevel: "silent",
    build: { outDir: join(root, "web"), emptyOutDir: true },
  });
  const priorCert = process.env["NODE_EXTRA_CA_CERTS"];
  const priorOrigin = process.env["PI_ORB_E2E_MCP_ORIGIN"];
  process.env["NODE_EXTRA_CA_CERTS"] = cert;
  process.env["PI_ORB_E2E_MCP_ORIGIN"] = origin;
  const cp = await startControlPlane({
    port: 7179,
    fake,
    nameFake: names,
    pglitePath: join(root, "db"),
    processStateDirectory: join(root, "hosts"),
    webDist: join(root, "web"),
    entry: "e2e/mcp-oauth-entry.ts",
  });
  if (priorCert === undefined) delete process.env["NODE_EXTRA_CA_CERTS"];
  else process.env["NODE_EXTRA_CA_CERTS"] = priorCert;
  if (priorOrigin === undefined) delete process.env["PI_ORB_E2E_MCP_ORIGIN"];
  else process.env["PI_ORB_E2E_MCP_ORIGIN"] = priorOrigin;
  const executablePath =
    process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"] ??
    (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  const project = randomUUID();
  const otherProject = randomUUID();
  const foreignOrb = randomUUID();
  const connection = randomUUID();
  const orbs = [randomUUID(), randomUUID()] as const;
  const runtimeTokenRequest = async (orbId: string) => {
    const metadata = JSON.parse(readFileSync(join(root, "hosts", orbId, "host.json"), "utf8")) as {
      runtimeToken: string;
    };
    return fetch(`${cp.baseUrl}/runtime/v1/mcp/${connection}/token?projectId=${project}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${metadata.runtimeToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ url: `${origin}/mcp`, projectId: project }),
    });
  };
  const configUrl = `${cp.baseUrl}/#/projects/${project}/mcp`;
  const consent = async () => {
    await page.goto(configUrl);
    await page.locator(".project-mcp-connection > summary").click();
    await page.getByRole("button", { name: /^(connect|reconnect)$/ }).click();
    await page.getByRole("link", { name: "Authorize fixture" }).click();
    await expectPage(page).toHaveURL(configUrl);
    await expectPage(page.locator(".project-mcp-connection > summary")).toContainText("connected");
  };
  const message = async (orb: string, index: number) => {
    expect(
      (
        await api(cp.baseUrl, "PUT", `/api/v1/orbs/${orb}/messages/${randomUUID()}`, {
          content: [{ type: "text", text: `OAuth ${index}` }],
        })
      ).status,
    ).toBe(202);
    await waitFor(
      `OAuth turn ${index} and summary`,
      async () => {
        const history = JSON.stringify(
          (await api(cp.baseUrl, "GET", `/api/v1/orbs/${orb}/history`)).body,
        );
        const requests = (await fakeControl(fake.sessionKey, "/requests")) as unknown as {
          matchedRuleIndex: number;
          status: number;
        }[];
        return history.includes(`OAUTH_DONE_${index}`) &&
          requests.some((r) => r.matchedRuleIndex === index * 3 + 2 && r.status === 200)
          ? true
          : null;
      },
      { timeoutMs: 90_000 },
    );
  };
  try {
    expect(
      (
        await api(cp.baseUrl, "POST", "/api/v1/projects", {
          id: project,
          name: "OAuth project",
          repositoryUrl: "https://github.com/schani/pi-orb",
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await api(cp.baseUrl, "PUT", `/api/v1/projects/${project}/mcp`, {
          revision: 0,
          servers: [
            {
              name: "fixture",
              url: `${origin}/mcp`,
              description: "OAuth test",
              headers: {},
              oauth: { id: connection },
            },
          ],
        })
      ).status,
    ).toBe(200);
    await consent();
    for (const [index, orb] of orbs.entries()) {
      expect(
        (await api(cp.baseUrl, "POST", `/api/v1/projects/${project}/orbs`, { id: orb })).status,
      ).toBe(202);
      if (index === 0) {
        const challenge = await waitFor(
          "model login",
          async () =>
            (
              (await api(cp.baseUrl, "GET", `/api/v1/orbs/${orb}`)).body["actionRequired"] as
                | { userCode?: string }
                | undefined
            )?.userCode ?? null,
          { timeoutMs: 60_000 },
        );
        await fakeControl(fake.sessionKey, "/deviceauth/approve", { user_code: challenge });
      }
      await waitFor(
        "OAuth orb running",
        async () => {
          const state = (await api(cp.baseUrl, "GET", `/api/v1/orbs/${orb}`)).body["state"];
          if (state === "failed") throw new FatalProbeError("OAuth orb failed");
          return state === "running" ? true : null;
        },
        { timeoutMs: 300_000 },
      );
      await message(orb, index);
    }
    expect(grant).toBe(1);
    expect(acceptedCalls).toBe(2);
    expect(
      (
        await api(cp.baseUrl, "POST", "/api/v1/projects", {
          id: otherProject,
          name: "Other project",
          repositoryUrl: "https://github.com/schani/pi-orb",
        })
      ).status,
    ).toBe(201);
    expect(
      (await api(cp.baseUrl, "POST", `/api/v1/projects/${otherProject}/orbs`, { id: foreignOrb }))
        .status,
    ).toBe(202);
    await waitFor(
      "foreign OAuth orb running",
      async () => {
        const state = (await api(cp.baseUrl, "GET", `/api/v1/orbs/${foreignOrb}`)).body["state"];
        if (state === "failed") throw new FatalProbeError("Foreign OAuth orb failed");
        return state === "running" ? true : null;
      },
      { timeoutMs: 300_000 },
    );
    expect((await runtimeTokenRequest(foreignOrb)).status).toBe(404);
    const delivered = await runtimeTokenRequest(orbs[0]);
    expect(delivered.status).toBe(200);
    expect(JSON.stringify(await delivered.json())).not.toContain("fixture-refresh-");
    rejectAccess = true;
    await message(orbs[0], 2);
    expect(acceptedCalls).toBe(2); // no replay
    await message(orbs[0], 3);
    expect(acceptedCalls).toBe(3);
    expect(refreshes).toBe(1);
    rejectAccess = true;
    rejectRefresh = true;
    await message(orbs[0], 4);
    expect(acceptedCalls).toBe(3);
    await message(orbs[0], 5);
    expect(acceptedCalls).toBe(3);
    await consent();
    await message(orbs[0], 6);
    expect(acceptedCalls).toBe(4);
    await page.goto(configUrl);
    await page.locator(".project-mcp-connection > summary").click();
    await page.getByRole("button", { name: "disconnect", exact: true }).click();
    await expectPage(page.locator(".project-mcp-connection > summary")).toContainText(
      "authorization required",
    );
    expect((await runtimeTokenRequest(orbs[0])).status).toBe(401);
    const history = JSON.stringify(
      (await api(cp.baseUrl, "GET", `/api/v1/orbs/${orbs[0]}/history`)).body,
    );
    expect(history).not.toContain("fixture-access-");
    expect(history).not.toContain("fixture-refresh-");
    expect(
      JSON.stringify((await api(cp.baseUrl, "GET", `/api/v1/projects/${project}/mcp`)).body),
    ).not.toContain("fixture-access-");
  } catch (error) {
    console.error(cp.logs.join(""));
    console.error(await page.locator("body").innerText());
    throw error;
  } finally {
    await browser.close();
    await api(cp.baseUrl, "DELETE", `/api/v1/projects/${project}`);
    await api(cp.baseUrl, "DELETE", `/api/v1/projects/${otherProject}`);
    await cp.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await deleteFakeSession(fake.sessionKey);
    await deleteFakeSession(names.sessionKey);
    rmSync(root, { recursive: true, force: true });
  }
});

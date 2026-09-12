import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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

it("MCP traverses browser → real Pi → authenticated HTTPS; new same-project orbs reuse configuration", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-orb-mcp-e2e-"));
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
      "/CN=pi-orb-mcp-test",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-days",
      "1",
    ],
    { stdio: "ignore" },
  );
  const calls: { method: string; authorization: string | undefined }[] = [];
  const remote = createServer(
    { key: readFileSync(key), cert: readFileSync(cert) },
    async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      const message = JSON.parse(body);
      calls.push({ method: message.method, authorization: req.headers.authorization });
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const results: Record<string, unknown> = {
        initialize: {
          protocolVersion: message.params?.protocolVersion,
          capabilities: { tools: {}, prompts: {}, resources: {} },
          serverInfo: { name: "fixture", version: "1", description: "MCP E2E inventory" },
        },
        "tools/list": {
          tools: [
            {
              name: "echo",
              inputSchema: {
                $schema: "https://json-schema.org/draft/2020-12/schema",
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
              },
            },
          ],
        },
        "prompts/list": { prompts: [{ name: "external" }] },
        "resources/list": { resources: [{ name: "readme", uri: "test://readme" }] },
        "resources/templates/list": {
          resourceTemplates: [{ name: "item", uriTemplate: "test://{id}" }],
        },
        "tools/call": { content: [{ type: "text", text: "MCP_CALL_OK" }] },
        "prompts/get": {
          messages: [{ role: "user", content: { type: "text", text: "MCP_EXTERNAL_PROMPT_DATA" } }],
        },
        "resources/read": { contents: [{ uri: "test://readme", text: "MCP_RESOURCE_OK" }] },
      };
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          ...(message.method in results
            ? { result: results[message.method] }
            : { error: { code: -32601, message: "not supported" } }),
        }),
      );
    },
  );
  await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
  const address = remote.address();
  if (!address || typeof address === "string") throw new Error("MCP server not listening");
  const fake = await createFakeSession(`mcp-e2e-${randomUUID()}`, {
    auth: { accountId: "mcp-test", device: { manualApprove: true } },
    model: {
      rules: [
        ...[0, 1].flatMap(() => [
          {
            match: { userMessage: { regex: "^MCP check$" } },
            steps: [
              { type: "toolCall", name: "mcp_search", arguments: { server: "fixture", limit: 4 } },
              {
                type: "toolCall",
                name: "mcp_read",
                arguments: { server: "fixture", kind: "prompt", name: "external" },
              },
              {
                type: "toolCall",
                name: "mcp_read",
                arguments: { server: "fixture", kind: "resource", uri: "test://readme" },
              },
              {
                type: "toolCall",
                name: "mcp_read",
                arguments: { server: "fixture", kind: "template", name: "item" },
              },
              {
                type: "toolCall",
                name: "mcp_call",
                arguments: { server: "fixture", tool: "echo", args: { value: "hello" } },
              },
              { type: "stop", status: "completed" },
            ],
          },
          {
            match: { toolResultContains: { regex: "MCP_CALL_OK" } },
            steps: [
              { type: "text", content: "MCP_CHECK_COMPLETE" },
              { type: "stop", status: "completed" },
            ],
          },
          {
            match: {
              userMessage: { regex: "^Write a single short desktop-notification sentence" },
            },
            steps: [
              { type: "text", content: "Checked MCP capabilities." },
              { type: "stop", status: "completed" },
            ],
          },
        ]),
        {
          match: { userMessage: { regex: "^MCP isolation$" } },
          steps: [
            {
              type: "toolCall",
              name: "bash",
              arguments: { command: 'test -z "$MCP_KEY" && echo MCP_ISOLATION_EMPTY' },
            },
            { type: "stop", status: "completed" },
          ],
        },
        {
          match: { toolResultContains: { regex: "MCP_ISOLATION_EMPTY" } },
          steps: [
            { type: "text", content: "MCP_ISOLATION_COMPLETE" },
            { type: "stop", status: "completed" },
          ],
        },
        {
          match: { userMessage: { regex: "^Write a single short desktop-notification sentence" } },
          steps: [
            { type: "text", content: "Checked project isolation." },
            { type: "stop", status: "completed" },
          ],
        },
      ],
    },
  });
  // Naming is an independent consumer; sharing the ordered model script races its cursor.
  const nameFake = await createFakeSession(`mcp-names-${randomUUID()}`, {
    model: {
      rules: [0, 1, 2].map(() => ({
        match: { default: true },
        steps: [
          { type: "text", content: "MCP Check" },
          { type: "stop", status: "completed" },
        ],
      })),
    },
  });
  const webRoot = join(import.meta.dirname, "../apps/web");
  await build({
    root: webRoot,
    configFile: join(webRoot, "vite.config.ts"),
    logLevel: "silent",
    build: { outDir: join(root, "web"), emptyOutDir: true },
  });
  const oldCert = process.env["NODE_EXTRA_CA_CERTS"];
  process.env["NODE_EXTRA_CA_CERTS"] = cert;
  const cp = await startControlPlane({
    port: 7168,
    fake,
    nameFake,
    pglitePath: join(root, "db"),
    processStateDirectory: join(root, "hosts"),
    webDist: join(root, "web"),
  });
  if (oldCert === undefined) delete process.env["NODE_EXTRA_CA_CERTS"];
  else process.env["NODE_EXTRA_CA_CERTS"] = oldCert;
  const executablePath =
    process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"] ??
    (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ["--no-sandbox"],
  });
  const project = randomUUID();
  const other = randomUUID();
  const waitRunning = async (id: string) =>
    waitFor(
      "MCP orb running",
      async () => {
        const view = await api(cp.baseUrl, "GET", `/api/v1/orbs/${id}`);
        if (view.body["state"] === "failed") throw new FatalProbeError(JSON.stringify(view.body));
        return view.body["state"] === "running" ? true : null;
      },
      { timeoutMs: 300_000 },
    );
  try {
    for (const id of [project, other])
      expect(
        (
          await api(cp.baseUrl, "POST", "/api/v1/projects", {
            id,
            name: id === project ? "MCP project" : "Unrelated project",
            repositoryUrl: "https://github.com/schani/pi-orb",
          })
        ).status,
      ).toBe(201);
    expect(
      (
        await api(cp.baseUrl, "PUT", `/api/v1/projects/${project}/secrets/MCP_KEY`, {
          value: "synthetic-first",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api(cp.baseUrl, "PUT", `/api/v1/projects/${project}/mcp`, {
          revision: 0,
          servers: [
            {
              name: "fixture",
              description: "MCP E2E inventory",
              url: `https://127.0.0.1:${address.port}/mcp`,
              headers: { Authorization: { secret: "MCP_KEY", prefix: "Bearer " } },
            },
          ],
        })
      ).status,
    ).toBe(200);
    const blockedDeletion = await api(
      cp.baseUrl,
      "DELETE",
      `/api/v1/projects/${project}/secrets/MCP_KEY`,
    );
    expect(blockedDeletion.status).toBe(409);
    expect(JSON.stringify(blockedDeletion.body)).toContain("used by MCP fixture");
    expect((await api(cp.baseUrl, "GET", `/api/v1/projects/${other}/mcp`)).body).toEqual({
      revision: 0,
      servers: [],
    });
    const first = randomUUID();
    expect(
      (await api(cp.baseUrl, "POST", `/api/v1/projects/${project}/orbs`, { id: first })).status,
    ).toBe(202);
    const challenge = await waitFor(
      "MCP login",
      async () => {
        const view = await api(cp.baseUrl, "GET", `/api/v1/orbs/${first}`);
        const action = view.body["actionRequired"] as { userCode?: string } | undefined;
        return action?.userCode || null;
      },
      { timeoutMs: 60_000 },
    );
    await fakeControl(fake.sessionKey, "/deviceauth/approve", { user_code: challenge });
    await waitRunning(first);
    expect(calls).toEqual([]); // Inventory is rendered without eager MCP discovery.
    const page = await browser.newPage();
    await page.goto(`${cp.baseUrl}/#/orbs/${first}`);
    // Pin inbox delivery rather than racing the browser's websocket attach.
    expect(
      (
        await api(cp.baseUrl, "PUT", `/api/v1/orbs/${first}/messages/${randomUUID()}`, {
          content: [{ type: "text", text: "MCP check" }],
        })
      ).status,
    ).toBe(202);
    // History arrives before output_retired. A list assertion retries the
    // transient two-copy handoff while still requiring exactly one visible copy.
    await expectPage(
      page.getByText("MCP_CHECK_COMPLETE", { exact: true }).filter({ visible: true }),
    ).toHaveText(["MCP_CHECK_COMPLETE"], { timeout: 60_000 });
    // A streamed completion is not the replication boundary. Wait for its durable marker.
    const encoded = await waitFor(
      "replicated MCP completion",
      async () => {
        const history = await api(cp.baseUrl, "GET", `/api/v1/orbs/${first}/history`);
        const encoded = JSON.stringify(history.body);
        return encoded.includes("MCP_CHECK_COMPLETE") ? encoded : null;
      },
      { timeoutMs: 60_000 },
    );
    expect(encoded).toContain("MCP_EXTERNAL_PROMPT_DATA");
    expect(encoded).toContain("MCP_RESOURCE_OK");
    expect(encoded).toContain("test://{id}");
    expect(encoded).not.toContain("synthetic-first");
    expect(calls.filter((c) => c.method === "tools/call")).toHaveLength(1);
    expect(calls.every((c) => c.authorization === "Bearer synthetic-first")).toBe(true);
    await waitFor(
      "first MCP summary consumed its scripted rule",
      async () => {
        const requests = (await fakeControl(fake.sessionKey, "/requests")) as unknown as {
          matchedRuleIndex: number | null;
          status: number;
        }[];
        return requests.some((request) => request.matchedRuleIndex === 2 && request.status === 200)
          ? true
          : null;
      },
      { timeoutMs: 60_000 },
    );
    expect(JSON.stringify(await fakeControl(fake.sessionKey, "/requests"))).toContain(
      "Available MCP servers:",
    );
    expect(
      (
        await api(cp.baseUrl, "PUT", `/api/v1/projects/${project}/secrets/MCP_KEY`, {
          value: "synthetic-second",
        })
      ).status,
    ).toBe(200);
    const second = randomUUID();
    expect(
      (await api(cp.baseUrl, "POST", `/api/v1/projects/${project}/orbs`, { id: second })).status,
    ).toBe(202);
    await waitRunning(second);
    await page.goto(`${cp.baseUrl}/#/orbs/${second}`);
    const index = page.getByRole("navigation", { name: "Project orbs" });
    await expectPage(index.locator(`a[href="#/orbs/${second}"]`)).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expectPage(index).toHaveAttribute("aria-busy", "false");
    await page.getByPlaceholder("Message the orb…").fill("MCP check");
    await page.getByPlaceholder("Message the orb…").press("Control+Enter");
    await expectPage(
      page.getByText("MCP_CHECK_COMPLETE", { exact: true }).filter({ visible: true }),
    ).toHaveText(["MCP_CHECK_COMPLETE"], { timeout: 60_000 });
    expect(calls.filter((c) => c.method === "tools/call").map((c) => c.authorization)).toEqual([
      "Bearer synthetic-first",
      "Bearer synthetic-second",
    ]);
    await waitFor(
      "second MCP summary",
      async () => {
        const requests = (await fakeControl(fake.sessionKey, "/requests")) as unknown as {
          matchedRuleIndex: number | null;
          status: number;
        }[];
        return requests.some((request) => request.matchedRuleIndex === 5 && request.status === 200)
          ? true
          : null;
      },
      { timeoutMs: 60_000 },
    );
    const isolated = randomUUID();
    expect(
      (await api(cp.baseUrl, "POST", `/api/v1/projects/${other}/orbs`, { id: isolated })).status,
    ).toBe(202);
    await waitRunning(isolated);
    await page.goto(`${cp.baseUrl}/#/orbs/${isolated}`);
    await expectPage(index.locator(`a[href="#/orbs/${isolated}"]`)).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expectPage(index).toHaveAttribute("aria-busy", "false");
    await page.getByPlaceholder("Message the orb…").fill("MCP isolation");
    await page.getByPlaceholder("Message the orb…").press("Control+Enter");
    await expectPage(
      page.getByText("MCP_ISOLATION_COMPLETE", { exact: true }).filter({ visible: true }),
    ).toHaveText(["MCP_ISOLATION_COMPLETE"], { timeout: 60_000 });
    const requests = (await fakeControl(fake.sessionKey, "/requests")) as unknown as {
      matchedRuleIndex: number | null;
      body: { tools?: { name: string }[]; instructions?: string };
    }[];
    const isolatedRequest = requests.find((request) => request.matchedRuleIndex === 6);
    expect(isolatedRequest).toBeDefined();
    expect(isolatedRequest?.body.tools?.some((tool) => tool.name.startsWith("mcp_"))).toBe(false);
    expect(isolatedRequest?.body.instructions).not.toContain("MCP E2E inventory");
    expect(calls.filter((call) => call.method === "tools/call")).toHaveLength(2);
    expect(
      (
        await api(cp.baseUrl, "PUT", `/api/v1/projects/${project}/mcp`, {
          revision: 1,
          servers: [],
        })
      ).status,
    ).toBe(200);
    expect((await api(cp.baseUrl, "GET", `/api/v1/projects/${project}/mcp`)).body).toEqual({
      revision: 2,
      servers: [],
    });
    expect(
      (await api(cp.baseUrl, "DELETE", `/api/v1/projects/${project}/secrets/MCP_KEY`)).status,
    ).toBe(200);
    expect(
      (
        await api(cp.baseUrl, "PUT", `/api/v1/projects/${project}/mcp`, {
          revision: 2,
          servers: [
            {
              name: "missing",
              description: "Missing secret",
              url: "https://example.com/mcp",
              headers: { Authorization: { secret: "MCP_KEY", prefix: "Bearer " } },
            },
          ],
        })
      ).status,
    ).toBe(409);
  } catch (error) {
    console.error(cp.logs.join(""));
    console.error("MCP requests", JSON.stringify(calls));
    console.error(
      "Inference requests",
      JSON.stringify(await fakeControl(fake.sessionKey, "/requests")),
    );
    for (const context of browser.contexts())
      for (const page of context.pages())
        console.error("Browser", await page.locator("body").innerText());
    throw error;
  } finally {
    await browser.close();
    await api(cp.baseUrl, "DELETE", `/api/v1/projects/${project}`);
    await api(cp.baseUrl, "DELETE", `/api/v1/projects/${other}`);
    await cp.stop();
    remote.closeAllConnections();
    await new Promise<void>((resolve) => remote.close(() => resolve()));
    await deleteFakeSession(fake.sessionKey);
    await deleteFakeSession(nameFake.sessionKey);
    rmSync(root, { recursive: true, force: true });
  }
});

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect as expectPage } from "@playwright/test";
import { build } from "vite";
import { expect, it } from "vitest";
import {
  api,
  createFakeSession,
  FAKE_ORIGIN,
  FatalProbeError,
  fakeControl,
  fakeRequest,
  type RecordedFakeRequest,
  startControlPlane,
  waitFor,
} from "./harness.ts";
import { finishMcpFixture } from "./mcp-artifacts.ts";
import { mcpFailureHistory, mcpFailureRequests } from "./mcp-diagnostics.ts";

it("MCP traverses root, restricted and default general-purpose delegates → authenticated HTTPS; same-project orbs reuse configuration", async () => {
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
      if (req.url === "/unavailable") {
        res.writeHead(503).end();
        return;
      }
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
          capabilities: { tools: {}, resources: {} },
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
        "resources/list": {
          resources: [{ name: "readme", uri: "test://readme" }],
          nextCursor: undefined,
        },
        "resources/templates/list": {
          resourceTemplates: [{ name: "item", uriTemplate: "test://{id}" }],
        },
        "tools/call": { content: [{ type: "text", text: "MCP_CALL_OK" }] },
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
        ...[0, 1].flatMap((index) => [
          ...(index === 1
            ? [
                {
                  match: { userMessage: { regex: "^MCP check$" } },
                  steps: [
                    {
                      type: "toolCall",
                      name: "bash",
                      arguments: {
                        command:
                          "mkdir -p .pi/agents && printf '%s\\n' '---' 'name: mcp-worker' 'description: Approved MCP worker' 'tools: codemode,mcp__fixture__echo,list_mcp_resources,list_mcp_resource_templates,read_mcp_resource' '---' 'Use codemode for the approved MCP tools.' > .pi/agents/mcp-worker.md && echo MCP_PROFILE_READY",
                      },
                    },
                    { type: "stop", status: "completed" },
                  ],
                },
                {
                  match: { toolResultContains: { regex: "MCP_PROFILE_READY" } },
                  steps: [
                    {
                      type: "toolCall",
                      name: "subagent",
                      arguments: {
                        subagent_type: "mcp-worker",
                        prompt: "MCP_CHILD_CHECK",
                        description: "Check approved MCP capabilities",
                        run_in_background: false,
                        inherit_context: false,
                      },
                    },
                    { type: "stop", status: "completed" },
                  ],
                },
              ]
            : []),
          {
            match: { userMessage: { regex: index === 1 ? "MCP_CHILD_CHECK" : "^MCP check$" } },
            steps: [
              {
                type: "toolCall",
                name: "codemode",
                arguments: {
                  code: "const resources = await tools.list_mcp_resources({server:'fixture'}); const templates = await tools.list_mcp_resource_templates({server:'fixture'}); const read = await tools.read_mcp_resource({server:'fixture',uri:'test://readme'}); const echo = await tools.mcp__fixture__echo({value:'hello'}); text(JSON.stringify({resources,templates,read,echo}));",
                },
              },
              { type: "stop", status: "completed" },
            ],
          },
          {
            match: { userMessage: { regex: index === 1 ? "MCP_CHILD_CHECK" : "^MCP check$" } },
            steps: [
              { type: "text", content: index === 1 ? "MCP_CHILD_COMPLETE" : "MCP_CHECK_COMPLETE" },
              { type: "stop", status: "completed" },
            ],
          },
          ...(index === 1
            ? [
                {
                  match: { userMessage: { regex: "^MCP check$" } },
                  steps: [
                    { type: "text", content: "MCP_CHECK_COMPLETE" },
                    { type: "stop", status: "completed" },
                  ],
                },
              ]
            : []),
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
          match: { userMessage: { regex: "^MCP default delegation$" } },
          steps: [
            {
              type: "toolCall",
              name: "subagent",
              arguments: {
                subagent_type: "general-purpose",
                prompt: "MCP_DEFAULT_CHILD_CHECK",
                description: "Check default MCP capabilities",
                run_in_background: false,
                inherit_context: false,
              },
            },
            { type: "stop", status: "completed" },
          ],
        },
        {
          match: { userMessage: { regex: "MCP_DEFAULT_CHILD_CHECK" } },
          steps: [
            {
              type: "toolCall",
              name: "codemode",
              arguments: {
                code: "const echo = await tools.mcp__fixture__echo({value:'default-child'}); text(JSON.stringify(echo));",
              },
            },
            { type: "stop", status: "completed" },
          ],
        },
        {
          match: { userMessage: { regex: "MCP_DEFAULT_CHILD_CHECK" } },
          steps: [
            { type: "text", content: "MCP_DEFAULT_CHILD_COMPLETE" },
            { type: "stop", status: "completed" },
          ],
        },
        {
          match: { userMessage: { regex: "^MCP default delegation$" } },
          steps: [
            { type: "text", content: "MCP_DEFAULT_COMPLETE" },
            { type: "stop", status: "completed" },
          ],
        },
        {
          match: { userMessage: { regex: "^Write a single short desktop-notification sentence" } },
          steps: [
            { type: "text", content: "Checked default delegation." },
            { type: "stop", status: "completed" },
          ],
        },
        {
          match: { userMessage: { regex: "^MCP isolation$" } },
          steps: [
            {
              type: "toolCall",
              name: "codemode",
              arguments: {
                code: 'text(await tools.bash({command: "test -z \\"$MCP_KEY\\" && echo MCP_ISOLATION_EMPTY"}))',
              },
            },
            { type: "stop", status: "completed" },
          ],
        },
        {
          match: { userMessage: { regex: "^MCP isolation$" } },
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
        {
          match: { userMessage: { regex: "^MCP unavailable$" } },
          steps: [
            { type: "text", content: "MCP_UNAVAILABLE_COMPLETE" },
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
    port: 7169,
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
  const first = randomUUID();
  const second = randomUUID();
  const isolated = randomUUID();
  const unavailable = randomUUID();
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
  let failed = false;
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
    expect(
      (await api(cp.baseUrl, "POST", `/api/v1/projects/${project}/orbs`, { id: first })).status,
    ).toBe(202);
    const challenge = await waitFor(
      "MCP login",
      async () => {
        const view = await api(cp.baseUrl, "GET", `/api/v1/orbs/${first}`);
        const action = view.body["actionRequired"] as
          | { userCode?: string; verificationUri?: string }
          | undefined;
        return action?.userCode && action.verificationUri ? action.userCode : null;
      },
      { timeoutMs: 60_000 },
    );
    await fakeControl(fake.sessionKey, "/deviceauth/approve", { user_code: challenge });
    await waitRunning(first);
    expect(calls.map((call) => call.method)).toEqual(
      expect.arrayContaining(["initialize", "tools/list", "resources/list"]),
    );
    expect(calls.some((call) => call.method === "tools/call")).toBe(false);
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
    await expectPage(page.getByText("MCP_CHECK_COMPLETE", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
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
    expect(encoded).toContain("MCP_RESOURCE_OK");
    expect(encoded).toContain("test://{id}");
    expect(encoded).toContain("mcp__fixture__echo");
    expect(encoded).toContain("nestedCalls");
    const nestedEcho = page.locator(".tool-nested-call").filter({ hasText: "mcp__fixture__echo" });
    await expectPage(nestedEcho).toHaveCount(1);
    await nestedEcho.locator("xpath=ancestor::details[1]/summary").click();
    await expectPage(nestedEcho).toBeVisible();
    expect(encoded).not.toContain("synthetic-first");
    expect(calls.some((call) => call.method === "resources/read")).toBe(true);
    expect(calls.some((call) => call.method === "resources/templates/list")).toBe(true);
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
    const firstRequests = (await fakeControl(fake.sessionKey, "/requests")) as unknown as {
      body?: { tools?: { name: string; description?: string }[]; instructions?: string };
    }[];
    expect(
      firstRequests.some((request) =>
        request.body?.tools
          ?.find((tool) => tool.name === "codemode")
          ?.description?.includes("mcp__fixture__echo"),
      ),
    ).toBe(true);
    expect(
      firstRequests.some((request) =>
        request.body?.instructions?.includes("fixture: MCP E2E inventory"),
      ),
    ).toBe(true);
    expect(
      (
        await api(cp.baseUrl, "PUT", `/api/v1/projects/${project}/secrets/MCP_KEY`, {
          value: "synthetic-second",
        })
      ).status,
    ).toBe(200);
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
    await page.getByRole("textbox", { name: "Message the orb", exact: true }).fill("MCP check");
    await page
      .getByRole("textbox", { name: "Message the orb", exact: true })
      .press("Control+Enter");
    await expectPage(page.getByText("MCP_CHECK_COMPLETE", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
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
        return requests.some((request) => request.matchedRuleIndex === 8 && request.status === 200)
          ? true
          : null;
      },
      { timeoutMs: 60_000 },
    );
    await page
      .getByRole("textbox", { name: "Message the orb", exact: true })
      .fill("MCP default delegation");
    await page
      .getByRole("textbox", { name: "Message the orb", exact: true })
      .press("Control+Enter");
    await expectPage(page.getByText("MCP_DEFAULT_COMPLETE", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    const defaultHistory = await waitFor(
      "replicated default delegation MCP call",
      async () => {
        const history = JSON.stringify(
          (await api(cp.baseUrl, "GET", `/api/v1/orbs/${second}/history`)).body,
        );
        return history.includes("MCP_DEFAULT_COMPLETE") ? history : null;
      },
      { timeoutMs: 60_000 },
    );
    expect(defaultHistory).toContain("MCP_DEFAULT_CHILD_COMPLETE");
    expect(defaultHistory).not.toContain("MCP_CALL_OK");
    expect(defaultHistory).not.toContain("synthetic-second");
    expect(calls.filter((c) => c.method === "tools/call").map((c) => c.authorization)).toEqual([
      "Bearer synthetic-first",
      "Bearer synthetic-second",
      "Bearer synthetic-second",
    ]);
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
    await page.getByRole("textbox", { name: "Message the orb", exact: true }).fill("MCP isolation");
    await page
      .getByRole("textbox", { name: "Message the orb", exact: true })
      .press("Control+Enter");
    await expectPage(page.getByText("MCP_ISOLATION_COMPLETE", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    const requests = (await fakeControl(fake.sessionKey, "/requests")) as unknown as {
      matchedRuleIndex: number | null;
      body: {
        tools?: { name: string; description?: string }[];
        instructions?: string;
        input?: { role?: string; content?: { text?: string }[] }[];
      };
    }[];
    const requestFor = (prompt: string) =>
      requests.find((request) =>
        request.body.input?.some(
          (item) => item.role === "user" && item.content?.some((block) => block.text === prompt),
        ),
      );
    const defaultChildRequest = requestFor("MCP_DEFAULT_CHILD_CHECK");
    expect(defaultChildRequest).toBeDefined();
    expect(defaultChildRequest?.body.tools?.map((tool) => tool.name)).toContain("codemode");
    expect(
      defaultChildRequest?.body.tools?.find((tool) => tool.name === "codemode")?.description,
    ).toContain("mcp__fixture__echo");
    expect(defaultChildRequest?.body.instructions).toContain("fixture: MCP E2E inventory");
    expect(defaultChildRequest?.body.tools?.some((tool) => tool.name === "subagent")).toBe(false);
    expect(defaultChildRequest?.body.tools?.some((tool) => tool.name.startsWith("mcp__"))).toBe(
      false,
    );
    const childRequest = requestFor("MCP_CHILD_CHECK");
    expect(childRequest).toBeDefined();
    expect(
      childRequest?.body.tools?.find((tool) => tool.name === "codemode")?.description,
    ).toContain("mcp__fixture__echo");
    expect(childRequest?.body.instructions).toContain("fixture: MCP E2E inventory");
    expect(
      requests.some(
        (request) =>
          JSON.stringify(request.body.input).includes("custom_tool_call_output") &&
          JSON.stringify(request.body.input).includes("MCP_CALL_OK"),
      ),
    ).toBe(true);
    expect(childRequest?.body.tools?.map((tool) => tool.name)).toContain("codemode");
    expect(childRequest?.body.tools?.some((tool) => tool.name.startsWith("mcp__"))).toBe(false);
    expect(childRequest?.body.tools?.some((tool) => tool.name === "subagent")).toBe(false);
    const isolatedRequest = requestFor("MCP isolation");
    expect(isolatedRequest).toBeDefined();
    expect(isolatedRequest?.body.tools?.map((tool) => tool.name)).toContain("codemode");
    expect(isolatedRequest?.body.tools?.some((tool) => tool.name.startsWith("mcp__"))).toBe(false);
    expect(
      isolatedRequest?.body.tools?.find((tool) => tool.name === "codemode")?.description,
    ).not.toContain("mcp__fixture__echo");
    expect(isolatedRequest?.body.instructions).not.toContain("MCP E2E inventory");
    expect(
      requests.some(
        (request) =>
          JSON.stringify(request.body.input).includes("custom_tool_call_output") &&
          JSON.stringify(request.body.input).includes("MCP_ISOLATION_EMPTY"),
      ),
    ).toBe(true);
    expect(calls.filter((call) => call.method === "tools/call")).toHaveLength(3);
    expect(
      (
        await api(cp.baseUrl, "PUT", `/api/v1/projects/${other}/mcp`, {
          revision: 0,
          servers: [
            {
              name: "unavailable",
              description: "Unavailable fixture",
              url: `https://127.0.0.1:${address.port}/unavailable`,
              headers: {},
            },
          ],
        })
      ).status,
    ).toBe(200);
    expect(
      (await api(cp.baseUrl, "POST", `/api/v1/projects/${other}/orbs`, { id: unavailable })).status,
    ).toBe(202);
    await waitRunning(unavailable);
    await page.goto(`${cp.baseUrl}/#/orbs/${unavailable}`);
    await expectPage(
      page.getByText("MCP unavailable: failed. Check project MCP settings."),
    ).toBeVisible({ timeout: 60_000 });
    const failedMcp = await waitFor(
      "replicated unavailable MCP edge",
      async () => {
        const history = JSON.stringify(
          (await api(cp.baseUrl, "GET", `/api/v1/orbs/${unavailable}/history`)).body,
        );
        return history.includes("MCP unavailable: failed. Check project MCP settings.")
          ? history
          : null;
      },
      { timeoutMs: 60_000 },
    );
    expect(failedMcp).not.toContain("synthetic-first");
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
    failed = true;
    throw error;
  } finally {
    await finishMcpFixture({
      failed,
      root,
      artifactDirectory: join(import.meta.dirname, "../.context/mcp-failures"),
      sessions: [fake.sessionKey, nameFake.sessionKey],
      mockOrigin: FAKE_ORIGIN,
      capture: async () => {
        const requests = await fakeControl(fake.sessionKey, "/requests").then(
          (value) => mcpFailureRequests(value as unknown as RecordedFakeRequest[]),
          () => "unavailable",
        );
        const history: Record<string, unknown> = {};
        for (const id of [first, second, isolated, unavailable])
          history[id] = await api(cp.baseUrl, "GET", `/api/v1/orbs/${id}/history`).then(
            (value) => mcpFailureHistory(value.body),
            () => "unavailable",
          );
        return { requests, history };
      },
      close: () => browser.close(),
      removeProjects: async () => {
        const results = await Promise.allSettled([
          api(cp.baseUrl, "DELETE", `/api/v1/projects/${project}`),
          api(cp.baseUrl, "DELETE", `/api/v1/projects/${other}`),
        ]);
        if (results.some((result) => result.status === "rejected" || result.value.status !== 202))
          throw new Error("project cleanup failed");
      },
      stop: () => cp.stop(),
      shutdownRemote: async () => {
        remote.closeAllConnections();
        await new Promise<void>((resolve) => remote.close(() => resolve()));
      },
      deleteSession: async (session) => {
        const response = await fakeRequest("DELETE", `/api/__mock__/sessions/${session}`, {
          retryTransport: false,
        });
        if (!response.ok) throw new Error("mock session deletion failed");
      },
    });
  }
});

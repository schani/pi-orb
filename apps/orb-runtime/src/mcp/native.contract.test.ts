import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  createMcpExtension,
  DefaultResourceLoader,
  type ExtensionFactory,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { NoSimulationTask } from "determined";
import { ok } from "neverthrow";
import { expect, it } from "vitest";
import { createNativeMcpTransport, createOrbMcpExtension, type OrbMcpState } from "./native.ts";
import { McpCredentialResolver } from "./oauth.ts";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function fixture(unavailable = false, templates404 = false) {
  const listed = barrier();
  const release = barrier();
  const calls: { method: string; token: string | undefined; static: string | undefined }[] = [];
  const state = {
    rejectOnce: 0,
    initialize401: false,
    rejectAlways403: false,
    plain403Once: false,
    invalidSessionOnce: false,
    responseLoss: false,
    redirect: false,
    redirectHits: 0,
    accepted: 0,
  };
  const server = createServer(async (req, res) => {
    if (req.url === "/redirect") {
      state.redirectHits++;
      return void res.writeHead(200).end("UNAPPROVED_REDIRECT");
    }
    if (req.method === "GET" || req.method === "DELETE") {
      calls.push({
        method: req.method,
        token: req.headers.authorization,
        static: req.headers["x-static"] as string | undefined,
      });
      return void res.writeHead(req.method === "GET" ? 405 : 204).end();
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString()) as {
      method?: string;
      id?: number;
    };
    calls.push({
      method: message.method ?? req.method ?? "",
      token: req.headers.authorization,
      static: req.headers["x-static"] as string | undefined,
    });
    if (unavailable) return void res.writeHead(503).end("UPSTREAM_PRIVATE_ERROR");
    if (message.method === "initialize" && state.initialize401)
      return void res.writeHead(401).end("UPSTREAM_PRIVATE_ERROR");
    if (message.method === "tools/call" && state.redirect)
      return void res.writeHead(302, { location: "/redirect" }).end();
    if (message.method === "tools/call" && state.plain403Once) {
      state.plain403Once = false;
      return void res.writeHead(403).end("UPSTREAM_PRIVATE_ERROR");
    }
    if (message.method === "tools/call" && state.rejectAlways403)
      return void res
        .writeHead(403, {
          "www-authenticate":
            'Bearer realm="fixture", error="insufficient_scope", scope="PRIVATE_SCOPE"',
        })
        .end("UPSTREAM_PRIVATE_ERROR");
    if (message.method === "tools/call" && state.rejectOnce) {
      const status = state.rejectOnce;
      state.rejectOnce = 0;
      return void res
        .writeHead(
          status,
          status === 403
            ? {
                "www-authenticate":
                  'Bearer realm="fixture", error="insufficient_scope", scope="PRIVATE_SCOPE"',
              }
            : {},
        )
        .end("UPSTREAM_PRIVATE_ERROR");
    }
    if (message.method === "tools/call" && state.invalidSessionOnce) {
      state.invalidSessionOnce = false;
      return void res.writeHead(404).end("UPSTREAM_PRIVATE_ERROR");
    }
    if (message.method === "tools/call") {
      state.accepted++;
      if (state.responseLoss) return void req.socket.destroy();
    }
    if (message.method === "tools/list") {
      listed.release();
      await release.promise;
    }
    if (templates404 && message.method === "resources/templates/list")
      return void res.writeHead(404, { "content-type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Method not found" },
        }),
      );
    if (message.id === undefined) return void res.writeHead(202).end();
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {}, ...(templates404 ? { resources: {} } : {}) },
            serverInfo: { name: "fixture", version: "1" },
          }
        : templates404 && message.method === "resources/list"
          ? { resources: [{ uri: "fixture://report", name: "report", mimeType: "text/plain" }] }
          : templates404 && message.method === "resources/read"
            ? {
                contents: [
                  { uri: "fixture://report", mimeType: "text/plain", text: "fixture report" },
                ],
              }
            : templates404 && message.method === "tools/call"
              ? { content: [{ type: "text", text: "echo works" }] }
              : { tools: [{ name: "echo", inputSchema: { type: "object", properties: {} } }] };
    res
      .writeHead(200, { "content-type": "application/json", "mcp-session-id": "fixture-session" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    listed: listed.promise,
    release: release.release,
    calls,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function sessionFor(
  url: string,
  onState: (event: OrbMcpState) => void,
  factory?: ExtensionFactory,
) {
  const dir = await mkdtemp(join(tmpdir(), "native-mcp-session-"));
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    extensionFactories: [
      factory ??
        createOrbMcpExtension({
          configs: [{ name: "fixture", description: "Fixture", url, headers: {} }],
          secrets: {},
          broker: { controlPlaneUrl: "http://127.0.0.1", runtimeToken: "unused" },
          task: new NoSimulationTask("native-session", false),
          onState,
        }),
    ],
  });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    allowModelNetwork: false,
  });
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    resourceLoader: loader,
    modelRuntime,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory(),
  });
  return {
    session,
    dir,
    close: async () => {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

it("first prompt waits for initial native discovery without blocking session readiness", async () => {
  const upstream = await fixture();
  const events: OrbMcpState[] = [];
  const embedded = await sessionFor(upstream.url, (event) => events.push(event));
  try {
    await embedded.session.bindExtensions({});
    let prepared = false;
    const firstPrompt = embedded.session.extensionRunner
      .emitBeforeAgentStart("hello", undefined, { cwd: process.cwd() })
      .then(() => {
        prepared = true;
      });
    await upstream.listed;
    expect(prepared).toBe(false);
    expect(
      embedded.session.extensionRunner.getToolDefinition("mcp__fixture__echo"),
    ).toBeUndefined();
    upstream.release();
    await firstPrompt;
    expect(embedded.session.extensionRunner.getToolDefinition("mcp__fixture__echo")).toBeDefined();
    expect(events).toEqual([]);
    await expect(readFile(join(embedded.dir, "mcp-auth.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(embedded.dir, "mcp.log"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    upstream.release();
    await embedded.close();
    await upstream.close();
  }
});

it("keeps native tools and resources available when optional templates return JSON-RPC -32601 over HTTP 404", async () => {
  const upstream = await fixture(false, true);
  upstream.release();
  const events: OrbMcpState[] = [];
  const embedded = await sessionFor(upstream.url, (event) => events.push(event));
  try {
    await embedded.session.bindExtensions({});
    await embedded.session.extensionRunner.emitBeforeAgentStart("hello", undefined, {
      cwd: process.cwd(),
    });
    expect(upstream.calls.map((call) => call.method)).toEqual(
      expect.arrayContaining([
        "initialize",
        "tools/list",
        "resources/list",
        "resources/templates/list",
      ]),
    );
    const tool = embedded.session.extensionRunner.getToolDefinition("mcp__fixture__echo");
    const list = embedded.session.extensionRunner.getToolDefinition("list_mcp_resources");
    const read = embedded.session.extensionRunner.getToolDefinition("read_mcp_resource");
    expect(tool).toBeDefined();
    expect(list).toBeDefined();
    expect(read).toBeDefined();
    const signal = new AbortController().signal;
    const execute = (definition: typeof tool, params: Record<string, string>) =>
      definition?.execute("call", params, signal, undefined, undefined as never);
    expect((await execute(tool, {}))?.content).toEqual([{ type: "text", text: "echo works" }]);
    expect((await execute(list, { server: "fixture" }))?.structuredContent).toEqual({
      server: "fixture",
      resources: [
        { server: "fixture", uri: "fixture://report", name: "report", mimeType: "text/plain" },
      ],
    });
    expect(
      (await execute(read, { server: "fixture", uri: "fixture://report" }))?.structuredContent,
    ).toEqual({
      server: "fixture",
      uri: "fixture://report",
      contents: [{ uri: "fixture://report", mimeType: "text/plain", text: "fixture report" }],
    });
    expect(upstream.calls.map((call) => call.method)).toEqual(
      expect.arrayContaining(["tools/call", "resources/read"]),
    );
    expect(events).toEqual([]);
  } finally {
    await embedded.close();
    await upstream.close();
  }
});

it("shutdown fences a late native startup before tool registration", async () => {
  const upstream = await fixture();
  const embedded = await sessionFor(upstream.url, () => {});
  let closed = false;
  try {
    await embedded.session.bindExtensions({});
    await upstream.listed;
    const stopped = embedded.close();
    upstream.release();
    await stopped;
    closed = true;
    expect(
      embedded.session.extensionRunner.getToolDefinition("mcp__fixture__echo"),
    ).toBeUndefined();
  } finally {
    upstream.release();
    if (!closed) await embedded.close();
    await upstream.close();
  }
});

it("same-SDK native retry bounds auth, reinitializes session 404, and never replays lost writes", async () => {
  const upstream = await fixture();
  upstream.release();
  const task = new NoSimulationTask("native-retry", false);
  let generation = 0;
  const rejected: (number | undefined)[] = [];
  const resolver = new McpCredentialResolver({
    request: async (_task, _signal, rejectedGeneration) => {
      rejected.push(rejectedGeneration);
      return ok({
        accessToken: `secret-${++generation}`,
        generation,
        expiresAt: task.wallNow() + 100_000,
      });
    },
  });
  const config = { name: "fixture", description: "Fixture", url: upstream.url, headers: {} };
  const embedded = await sessionFor(
    upstream.url,
    () => {},
    createMcpExtension({
      loadConfig: () => ({
        errors: [],
        servers: [
          {
            name: "fixture",
            source: "boot",
            config: { url: upstream.url, headers: { Authorization: "pi-orb-broker" } },
          },
        ],
      }),
      createTransport: () =>
        createNativeMcpTransport({ config, resolver, headers: { "X-Static": "approved" }, task }),
    }),
  );
  try {
    await embedded.session.bindExtensions({});
    await embedded.session.extensionRunner.emitBeforeAgentStart("hello", undefined, {
      cwd: process.cwd(),
    });
    const tool = embedded.session.extensionRunner.getToolDefinition("mcp__fixture__echo");
    expect(tool).toBeDefined();
    const call = () =>
      tool?.execute("call", {}, new AbortController().signal, undefined, undefined as never);
    upstream.state.rejectOnce = 401;
    await call();
    expect(upstream.calls.filter((c) => c.method === "tools/call").map((c) => c.token)).toEqual([
      "Bearer secret-1",
      "Bearer secret-2",
    ]);
    expect(rejected).toEqual([undefined, 1]);
    upstream.state.rejectOnce = 403;
    await call();
    expect(upstream.calls.filter((c) => c.method === "tools/call")).toHaveLength(4);
    upstream.state.rejectAlways403 = true;
    await expect(call()).rejects.toMatchObject({
      message: expect.not.stringMatching(/UPSTREAM_PRIVATE_ERROR|PRIVATE_SCOPE/),
    });
    upstream.state.rejectAlways403 = false;
    expect(upstream.calls.filter((c) => c.method === "tools/call")).toHaveLength(6);
    upstream.state.plain403Once = true;
    await expect(call()).rejects.toThrow();
    expect(upstream.calls.filter((c) => c.method === "tools/call")).toHaveLength(7);
    upstream.state.invalidSessionOnce = true;
    await call();
    expect(upstream.calls.filter((c) => c.method === "initialize")).toHaveLength(2);
    expect(upstream.state.accepted).toBe(3);
    upstream.state.responseLoss = true;
    await expect(call()).rejects.toThrow();
    expect(upstream.state.accepted).toBe(4);
    expect(upstream.calls.filter((c) => c.method === "tools/call")).toHaveLength(10);
    upstream.state.responseLoss = false;
    upstream.state.redirect = true;
    await expect(call()).rejects.toThrow();
    expect(upstream.state.redirectHits).toBe(0);
    expect(upstream.calls.some((c) => c.method === "GET")).toBe(true);
    expect(upstream.calls.every((c) => c.static === "approved")).toBe(true);
    expect(JSON.stringify(upstream.calls)).not.toContain("pi-orb-broker");
  } finally {
    await embedded.close();
    await upstream.close();
  }
});

it("production broker endpoint vends per-request OAuth tokens without guest auth files", async () => {
  const upstream = await fixture();
  upstream.release();
  const brokerRequests: Array<{
    rejectedGeneration: number | undefined;
    token: string | undefined;
    path: string | undefined;
    url: string;
  }> = [];
  const broker = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as {
      url: string;
      rejectedGeneration?: number;
    };
    brokerRequests.push({
      rejectedGeneration: body.rejectedGeneration,
      token: req.headers.authorization,
      path: req.url,
      url: body.url,
    });
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        accessToken: `private-${brokerRequests.length}`,
        expiresAt: Date.now() + 3_600_000,
        generation: brokerRequests.length,
      }),
    );
  });
  broker.listen(0, "127.0.0.1");
  await once(broker, "listening");
  const address = broker.address();
  if (!address || typeof address === "string") throw new Error("Missing broker port");
  const embedded = await sessionFor(
    upstream.url,
    () => {},
    createOrbMcpExtension({
      configs: [
        {
          name: "fixture",
          description: "Fixture",
          url: upstream.url,
          headers: {},
          oauth: { id: "10000000-0000-4000-8000-000000000001" },
        },
      ],
      secrets: {},
      broker: {
        controlPlaneUrl: `http://127.0.0.1:${address.port}`,
        runtimeToken: "private-runtime-token",
      },
      task: new NoSimulationTask("brokered-native", false),
    }),
  );
  try {
    await embedded.session.bindExtensions({});
    await embedded.session.extensionRunner.emitBeforeAgentStart("hello", undefined, {
      cwd: process.cwd(),
    });
    const tool = embedded.session.extensionRunner.getToolDefinition("mcp__fixture__echo");
    expect(tool).toBeDefined();
    upstream.state.rejectOnce = 401;
    await tool?.execute("call", {}, new AbortController().signal, undefined, undefined as never);
    expect(brokerRequests).toEqual([
      {
        rejectedGeneration: undefined,
        token: "Bearer private-runtime-token",
        path: "/runtime/v1/mcp/10000000-0000-4000-8000-000000000001/token",
        url: upstream.url,
      },
      {
        rejectedGeneration: 1,
        token: "Bearer private-runtime-token",
        path: "/runtime/v1/mcp/10000000-0000-4000-8000-000000000001/token",
        url: upstream.url,
      },
    ]);
    expect(upstream.calls.filter((c) => c.method === "tools/call").map((c) => c.token)).toEqual([
      "Bearer private-1",
      "Bearer private-2",
    ]);
    await expect(readFile(join(embedded.dir, "mcp-auth.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await embedded.close();
    await upstream.close();
    await new Promise<void>((resolve) => broker.close(() => resolve()));
  }
});

it("invalid approved static binding reports a safe named failure without network access", async () => {
  const upstream = await fixture();
  const events: OrbMcpState[] = [];
  const embedded = await sessionFor(
    upstream.url,
    (event) => events.push(event),
    createOrbMcpExtension({
      configs: [
        {
          name: "fixture",
          description: "Fixture",
          url: upstream.url,
          headers: { Authorization: { secret: "MISSING" } },
        },
      ],
      secrets: {},
      broker: { controlPlaneUrl: "http://127.0.0.1", runtimeToken: "unused" },
      task: new NoSimulationTask("invalid-binding", false),
      onState: (event) => events.push(event),
    }),
  );
  try {
    await embedded.session.bindExtensions({});
    await embedded.session.extensionRunner.emitBeforeAgentStart("hello", undefined, {
      cwd: process.cwd(),
    });
    expect(events).toEqual([
      {
        server: "fixture",
        sessionId: embedded.session.sessionManager.getSessionId(),
        state: "failed",
        message: "MCP fixture: missing or invalid secret/header binding",
        diagnostic: { code: "invalid_binding" },
      },
    ]);
    expect(upstream.calls).toEqual([]);
  } finally {
    upstream.release();
    await embedded.close();
    await upstream.close();
  }
});

it("two session factories attribute startup failure to their own Pi sessions", async () => {
  const upstream = await fixture(true);
  const events: OrbMcpState[] = [];
  const first = await sessionFor(upstream.url, (event) => events.push(event));
  const second = await sessionFor(upstream.url, (event) => events.push(event));
  try {
    await first.session.bindExtensions({});
    await second.session.bindExtensions({});
    await first.session.extensionRunner.emitBeforeAgentStart("hello", undefined, {
      cwd: process.cwd(),
    });
    await second.session.extensionRunner.emitBeforeAgentStart("hello", undefined, {
      cwd: process.cwd(),
    });
    expect(first.session.sessionManager.getSessionId()).not.toBe(
      second.session.sessionManager.getSessionId(),
    );
    expect(events).toEqual(
      [first, second].map(({ session }) => ({
        server: "fixture",
        sessionId: session.sessionManager.getSessionId(),
        state: "failed",
        message: "MCP fixture unavailable; check project MCP settings",
        diagnostic: { code: "upstream_http", httpStatus: 503 },
      })),
    );
  } finally {
    await first.close();
    await second.close();
    await upstream.close();
  }
});

it("broker auth_required on startup reports needs-auth with its Pi session", async () => {
  const upstream = await fixture();
  const broker = createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* drain request */
    }
    res.writeHead(403, { "content-type": "application/json" }).end(
      JSON.stringify({
        error: {
          code: "auth_required",
          message: "Reconnect from project settings",
          retryable: false,
        },
      }),
    );
  });
  broker.listen(0, "127.0.0.1");
  await once(broker, "listening");
  const address = broker.address();
  if (!address || typeof address === "string") throw new Error("Missing broker port");
  const events: OrbMcpState[] = [];
  const embedded = await sessionFor(
    upstream.url,
    (event) => events.push(event),
    createOrbMcpExtension({
      configs: [
        {
          name: "fixture",
          description: "Fixture",
          url: upstream.url,
          headers: {},
          oauth: { id: "10000000-0000-4000-8000-000000000001" },
        },
      ],
      secrets: {},
      broker: { controlPlaneUrl: `http://127.0.0.1:${address.port}`, runtimeToken: "private" },
      task: new NoSimulationTask("auth-required", false),
      onState: (event) => events.push(event),
    }),
  );
  try {
    await embedded.session.bindExtensions({});
    await embedded.session.extensionRunner.emitBeforeAgentStart("hello", undefined, {
      cwd: process.cwd(),
    });
    expect(events).toEqual([
      {
        server: "fixture",
        sessionId: embedded.session.sessionManager.getSessionId(),
        state: "needs-auth",
        message: "MCP fixture authorization required; reconnect in project MCP settings",
        diagnostic: { code: "auth_required" },
      },
    ]);
    expect(upstream.calls).toEqual([]);
  } finally {
    upstream.release();
    await embedded.close();
    await upstream.close();
    await new Promise<void>((resolve) => broker.close(() => resolve()));
  }
});

it("recovers broker-denied native tools and resources on the next ordinary turn without replaying calls", async () => {
  const upstream = await fixture(false, true);
  upstream.release();
  let granted = false;
  let brokerRequests = 0;
  const broker = createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* drain */
    }
    brokerRequests++;
    res
      .writeHead(granted ? 200 : 403, { "content-type": "application/json" })
      .end(
        JSON.stringify(
          granted
            ? { accessToken: "fixture-access", generation: 1, expiresAt: Date.now() + 3_600_000 }
            : { error: { code: "auth_required", message: "Reconnect", retryable: false } },
        ),
      );
  });
  broker.listen(0, "127.0.0.1");
  await once(broker, "listening");
  const address = broker.address();
  if (!address || typeof address === "string") throw new Error("Missing broker port");
  const events: OrbMcpState[] = [];
  const embedded = await sessionFor(
    upstream.url,
    (event) => events.push(event),
    createOrbMcpExtension({
      configs: [
        {
          name: "fixture",
          description: "Fixture",
          url: upstream.url,
          headers: {},
          oauth: { id: "10000000-0000-4000-8000-000000000001" },
        },
      ],
      secrets: {},
      broker: { controlPlaneUrl: `http://127.0.0.1:${address.port}`, runtimeToken: "private" },
      task: new NoSimulationTask("auth-recovery", false),
      onState: (event) => events.push(event),
    }),
  );
  try {
    await embedded.session.bindExtensions({});
    const turn = () =>
      embedded.session.extensionRunner.emitBeforeAgentStart("ordinary user turn", undefined, {
        cwd: embedded.dir,
      });
    await turn();
    expect(brokerRequests).toBe(1);
    expect(upstream.calls).toEqual([]);
    expect(
      embedded.session.extensionRunner.getToolDefinition("mcp__fixture__echo"),
    ).toBeUndefined();
    expect(events.map((event) => event.state)).toEqual(["needs-auth"]);
    await turn();
    expect(
      embedded.session.extensionRunner.getToolDefinition("mcp__fixture__echo"),
    ).toBeUndefined();
    expect(events.map((event) => event.state)).toEqual(["needs-auth"]);
    granted = true;
    await turn();
    expect(brokerRequests).toBeGreaterThan(1);
    expect(embedded.session.extensionRunner.getToolDefinition("mcp__fixture__echo")).toBeDefined();
    expect(embedded.session.extensionRunner.getToolDefinition("read_mcp_resource")).toBeDefined();
    expect(events.map((event) => event.state)).toEqual(["needs-auth", "connected"]);
    expect(upstream.calls.some((call) => call.method === "tools/call")).toBe(false);
    await turn();
    expect(brokerRequests).toBe(3);
  } finally {
    await embedded.close();
    await upstream.close();
    await new Promise<void>((resolve) => broker.close(() => resolve()));
  }
});

it("recovers on the first prompt when startup failed before any prompt", async () => {
  const upstream = await fixture();
  upstream.release();
  let granted = false;
  let requests = 0;
  const denied = barrier();
  const broker = createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* drain */
    }
    requests++;
    res
      .writeHead(granted ? 200 : 403, { "content-type": "application/json" })
      .end(
        JSON.stringify(
          granted
            ? { accessToken: "fixture-access", generation: 1, expiresAt: Date.now() + 3_600_000 }
            : { error: { code: "auth_required", message: "Reconnect", retryable: false } },
        ),
      );
  });
  broker.listen(0, "127.0.0.1");
  await once(broker, "listening");
  const address = broker.address();
  if (!address || typeof address === "string") throw new Error("Missing broker port");
  const embedded = await sessionFor(
    upstream.url,
    () => {},
    createOrbMcpExtension({
      configs: [
        {
          name: "fixture",
          description: "Fixture",
          url: upstream.url,
          headers: {},
          oauth: { id: "10000000-0000-4000-8000-000000000001" },
        },
      ],
      secrets: {},
      broker: { controlPlaneUrl: `http://127.0.0.1:${address.port}`, runtimeToken: "private" },
      task: new NoSimulationTask("auth-before-first-prompt", false),
      onState: (event) => {
        if (event.state === "needs-auth") denied.release();
      },
    }),
  );
  try {
    await embedded.session.bindExtensions({});
    await denied.promise;
    granted = true;
    await embedded.session.extensionRunner.emitBeforeAgentStart("first user prompt", undefined, {
      cwd: embedded.dir,
    });
    expect(requests).toBe(2);
    expect(embedded.session.extensionRunner.getToolDefinition("mcp__fixture__echo")).toBeDefined();
  } finally {
    await embedded.close();
    await upstream.close();
    await new Promise<void>((resolve) => broker.close(() => resolve()));
  }
});

it("coalesces concurrent recovery and fences late broker grant after shutdown", async () => {
  const upstream = await fixture(false, true);
  upstream.release();
  const requested = barrier();
  const released = barrier();
  let requests = 0;
  const broker = createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* drain */
    }
    requests++;
    if (requests > 1) {
      requested.release();
      await released.promise;
    }
    if (res.destroyed) return;
    res
      .writeHead(requests === 1 ? 403 : 200, { "content-type": "application/json" })
      .end(
        JSON.stringify(
          requests === 1
            ? { error: { code: "auth_required", message: "Reconnect", retryable: false } }
            : { accessToken: "fixture-access", generation: 1, expiresAt: Date.now() + 3_600_000 },
        ),
      );
  });
  broker.listen(0, "127.0.0.1");
  await once(broker, "listening");
  const address = broker.address();
  if (!address || typeof address === "string") throw new Error("Missing broker port");
  const events: OrbMcpState[] = [];
  const embedded = await sessionFor(
    upstream.url,
    (event) => events.push(event),
    createOrbMcpExtension({
      configs: [
        {
          name: "fixture",
          description: "Fixture",
          url: upstream.url,
          headers: {},
          oauth: { id: "10000000-0000-4000-8000-000000000001" },
        },
      ],
      secrets: {},
      broker: { controlPlaneUrl: `http://127.0.0.1:${address.port}`, runtimeToken: "private" },
      task: new NoSimulationTask("auth-close", false),
      onState: (event) => events.push(event),
    }),
  );
  try {
    await embedded.session.bindExtensions({});
    const turn = () =>
      embedded.session.extensionRunner.emitBeforeAgentStart("coding", undefined, {
        cwd: embedded.dir,
      });
    await turn();
    expect(events.map((event) => event.state)).toEqual(["needs-auth"]);
    const first = turn();
    const second = turn();
    await requested.promise;
    expect(requests).toBe(2);
    const closing = embedded.session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    released.release();
    await Promise.all([first, second, closing]);
    expect(requests).toBe(2);
    expect(
      embedded.session.extensionRunner.getToolDefinition("mcp__fixture__echo"),
    ).toBeUndefined();
    expect(events.some((event) => event.state === "connected")).toBe(false);
  } finally {
    released.release();
    await embedded.close();
    await upstream.close();
    await new Promise<void>((resolve) => broker.close(() => resolve()));
  }
});

it("does not retry failed static bindings on later turns", async () => {
  const upstream = await fixture();
  const events: OrbMcpState[] = [];
  const embedded = await sessionFor(
    upstream.url,
    (event) => events.push(event),
    createOrbMcpExtension({
      configs: [
        {
          name: "fixture",
          description: "Fixture",
          url: upstream.url,
          headers: { "x-static": { secret: "missing" } },
        },
      ],
      secrets: {},
      broker: { controlPlaneUrl: "http://127.0.0.1", runtimeToken: "unused" },
      task: new NoSimulationTask("static-no-retry", false),
      onState: (event) => events.push(event),
    }),
  );
  try {
    await embedded.session.bindExtensions({});
    const turn = () =>
      embedded.session.extensionRunner.emitBeforeAgentStart("coding", undefined, {
        cwd: embedded.dir,
      });
    await turn();
    await turn();
    expect(events.map((event) => event.state)).toEqual(["failed"]);
    expect(upstream.calls).toEqual([]);
  } finally {
    upstream.release();
    await embedded.close();
    await upstream.close();
  }
});

it("persistent startup 401 after native bounded retry reports needs-auth", async () => {
  const upstream = await fixture();
  upstream.state.initialize401 = true;
  const broker = createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* drain request */
    }
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        accessToken: "private-token",
        generation: ++generation,
        expiresAt: Date.now() + 3_600_000,
      }),
    );
  });
  let generation = 0;
  broker.listen(0, "127.0.0.1");
  await once(broker, "listening");
  const address = broker.address();
  if (!address || typeof address === "string") throw new Error("Missing broker port");
  const events: OrbMcpState[] = [];
  const embedded = await sessionFor(
    upstream.url,
    (event) => events.push(event),
    createOrbMcpExtension({
      configs: [
        {
          name: "fixture",
          description: "Fixture",
          url: upstream.url,
          headers: {},
          oauth: { id: "10000000-0000-4000-8000-000000000001" },
        },
      ],
      secrets: {},
      broker: { controlPlaneUrl: `http://127.0.0.1:${address.port}`, runtimeToken: "private" },
      task: new NoSimulationTask("persistent-401", false),
      onState: (event) => events.push(event),
    }),
  );
  try {
    await embedded.session.bindExtensions({});
    await embedded.session.extensionRunner.emitBeforeAgentStart("hello", undefined, {
      cwd: process.cwd(),
    });
    expect(upstream.calls.filter((call) => call.method === "initialize")).toHaveLength(2);
    expect(events).toEqual([
      {
        server: "fixture",
        sessionId: embedded.session.sessionManager.getSessionId(),
        state: "needs-auth",
        message: "MCP fixture authorization required; reconnect in project MCP settings",
        diagnostic: { code: "auth_required", httpStatus: 401 },
      },
    ]);
  } finally {
    upstream.release();
    await embedded.close();
    await upstream.close();
    await new Promise<void>((resolve) => broker.close(() => resolve()));
  }
});

it("unavailable server does not fail coding readiness and yields a named failure edge", async () => {
  const upstream = await fixture(true);
  const events: OrbMcpState[] = [];
  const embedded = await sessionFor(upstream.url, (event) => events.push(event));
  try {
    await embedded.session.bindExtensions({});
    await embedded.session.extensionRunner.emitBeforeAgentStart("hello", undefined, {
      cwd: process.cwd(),
    });
    expect(events).toEqual([
      {
        server: "fixture",
        sessionId: embedded.session.sessionManager.getSessionId(),
        state: "failed",
        message: "MCP fixture unavailable; check project MCP settings",
        diagnostic: { code: "upstream_http", httpStatus: 503 },
      },
    ]);
  } finally {
    await embedded.close();
    await upstream.close();
  }
});

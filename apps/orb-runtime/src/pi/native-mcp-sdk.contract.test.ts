import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createAgentSession,
  createMcpExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  StreamableHttpTransport,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it } from "vitest";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("exports the same MCP transport constructor used by native connection recovery", async () => {
  const ownMcp = await import(
    pathToFileURL(
      join(import.meta.dirname, "../../../../node_modules/@earendil-works/pi-mcp/dist/index.js"),
    ).href
  );
  expect(StreamableHttpTransport).toBe(ownMcp.StreamableHttpTransport);
});

it("native transport recognizes an invalid MCP session and retries once", async () => {
  let initialized = 0;
  let calls = 0;
  const server = createServer(async (request, response) => {
    if (request.method === "GET") {
      response.writeHead(405).end();
      return;
    }
    if (request.method === "DELETE") {
      response.writeHead(204).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString()) as {
      id?: number;
      method: string;
    };
    if (message.method === "tools/call") calls++;
    if (message.method === "tools/call" && calls === 1) {
      response.writeHead(404).end("private session error");
      return;
    }
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: "2025-06-18",
            serverInfo: { name: "fixture", version: "1" },
            capabilities: { tools: {} },
          }
        : message.method === "tools/list"
          ? { tools: [{ name: "write", inputSchema: { type: "object", properties: {} } }] }
          : { content: [{ type: "text", text: "accepted" }] };
    if (message.method === "initialize") initialized++;
    response
      .writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": `session-${initialized}`,
      })
      .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture address");
  const dir = mkdtempSync(join(tmpdir(), "pi-orb-mcp-retry-"));
  dirs.push(dir);
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: join(dir, "agent"),
      extensionFactories: [
        createMcpExtension({
          loadConfig: () => ({
            errors: [],
            servers: [
              {
                name: "fixture",
                source: "boot",
                config: { url: `http://127.0.0.1:${address.port}/mcp`, exposure: "direct" },
              },
            ],
          }),
          createTransport: (entry) => {
            if (!("url" in entry.config)) throw new Error("expected HTTP fixture");
            return new StreamableHttpTransport({ url: entry.config.url });
          },
        }),
      ],
    });
    await loader.reload();
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      allowModelNetwork: false,
    });
    ({ session } = await createAgentSession({
      cwd: dir,
      agentDir: join(dir, "agent"),
      resourceLoader: loader,
      modelRuntime: runtime,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
    }));
    await session.bindExtensions({});
    const deadline = AbortSignal.timeout(3000);
    let tool = session.extensionRunner.getToolDefinition("mcp__fixture__write");
    while (!tool && !deadline.aborted) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      tool = session.extensionRunner.getToolDefinition("mcp__fixture__write");
    }
    expect(tool).toBeDefined();
    if (!tool) throw new Error("native MCP tool did not register");
    const execute = tool.execute as unknown as (
      id: string,
      input: Record<string, unknown>,
      signal: AbortSignal,
    ) => Promise<{ content: unknown[] }>;
    const result = await execute("call-id", {}, new AbortController().signal);
    expect(result.content).toContainEqual({ type: "text", text: "accepted" });
    expect({ initialized, calls }).toEqual({ initialized: 2, calls: 2 });
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  } finally {
    session?.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 10000);

it("observes native server connection failure without exposing its raw error or breaking cleanup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-orb-mcp-observer-"));
  dirs.push(dir);
  const states: Array<{ name: string; state: string }> = [];
  let observed!: () => void;
  const observation = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: join(dir, "agent"),
    extensionFactories: [
      createMcpExtension({
        loadConfig: () => ({
          errors: [],
          servers: [
            {
              name: "offline",
              source: "boot",
              config: { url: "http://127.0.0.1:1/mcp", exposure: "direct" },
            },
          ],
        }),
        createTransport: () => {
          throw new Error("private credential must stay inside SDK");
        },
        retryConnectionOnPrompt: () => {
          throw new Error("eligibility callback must not interrupt coding");
        },
        onServerChange: (name, state) => {
          states.push({ name, state });
          if (state === "failed") observed();
          throw new Error("observer must not break cleanup");
        },
      }),
    ],
  });
  await loader.reload();
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    allowModelNetwork: false,
  });
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: join(dir, "agent"),
    resourceLoader: loader,
    modelRuntime: runtime,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory(),
  });
  try {
    await session.bindExtensions({});
    await observation;
    await session.extensionRunner.emitBeforeAgentStart("ordinary user turn", undefined, {
      cwd: dir,
    });
    expect(states).toContainEqual({ name: "offline", state: "failed" });
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  } finally {
    session.dispose();
  }
}, 10000);

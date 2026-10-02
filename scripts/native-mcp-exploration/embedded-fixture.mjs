import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { ResultAsync } from "neverthrow";

function barrier() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

export function openEmbeddedFixture(options = {}) {
  return ResultAsync.fromPromise(createFixture(options), (cause) => ({
    type: "fixture_failed",
    message: String(cause),
  }));
}

async function createFixture({
  blockedCall = false,
  blockedStartup = false,
  failStartup = false,
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "embedded-pi-history-"));
  const agentDir = join(dir, "agent");
  await mkdir(agentDir);
  const accepted = barrier();
  const blocked = barrier();
  const startupAccepted = barrier();
  const startupBlocked = barrier();
  const terminated = barrier();
  const active = new Set();
  const pending = new Set();
  let nextSession = 0;
  const requests = [];
  const server = createServer(async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (req.method === "DELETE") {
      requests.push({ method: "DELETE", sessionId });
      if (!active.delete(sessionId)) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200);
      res.end();
      return;
    }
    if (req.method === "GET") {
      res.writeHead(active.has(sessionId) ? 405 : 404);
      res.end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ method: message.method, sessionId, params: message.params });
    if (failStartup) {
      res.writeHead(400);
      res.end("fixture startup refused");
      return;
    }
    if (message.method === "initialize") {
      const id = `fixture-${++nextSession}`;
      startupAccepted.release();
      if (blockedStartup) await startupBlocked.promise;
      pending.add(id);
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": id });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          },
        }),
      );
      return;
    }
    if (message.method === "notifications/initialized" && pending.delete(sessionId)) {
      active.add(sessionId);
      res.writeHead(202);
      res.end();
      return;
    }
    if (!active.has(sessionId)) {
      res.writeHead(404);
      res.end("unknown MCP session");
      return;
    }
    const respond = (result) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    };
    if (message.method === "tools/list")
      respond({
        tools: [
          {
            name: "echo",
            description: "Echo a marker",
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
            },
          },
        ],
      });
    else if (message.method === "tools/call") {
      accepted.release();
      if (blockedCall) await blocked.promise;
      respond({
        content: [{ type: "text", text: `fixture-result:${message.params.arguments.value}` }],
      });
    } else {
      res.writeHead(202);
      res.end();
    }
  });
  const listening = await ResultAsync.fromPromise(
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    }),
    (cause) => ({ type: "listen_failed", cause: String(cause) }),
  );
  if (listening.isErr()) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(listening.error.cause);
  }
  const port = server.address().port;
  const manager = SessionManager.create(dir, join(dir, "sessions"));
  let session;
  let runtime;
  let createRuntime;
  let faux;
  let script;
  let closePromise;
  const events = [];
  const fixture = {
    dir,
    manager,
    events,
    requests,
    callAccepted: accepted.promise,
    callTerminated: terminated.promise,
    startupAccepted: startupAccepted.promise,
    releaseCall: blocked.release,
    releaseStartup: startupBlocked.release,
    get connections() {
      return active.size;
    },
    get session() {
      return session;
    },
    async start() {
      const modelRuntime = await ModelRuntime.create({
        authPath: join(dir, "auth.json"),
        allowModelNetwork: false,
      });
      faux = fauxProvider({ provider: "embedded-probe" });
      script =
        'const matches = await searchTools("echo"); const response = await tools.mcp__fixture__echo({value:"marker"}); store("evidence", {matches:matches.length, response}); text(JSON.stringify(response));';
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("codemode", { code: script })),
        fauxAssistantMessage("complete"),
      ]);
      modelRuntime.registerNativeProvider(faux.provider);
      const settingsManager = SettingsManager.inMemory();
      settingsManager.applyOverrides({ defaultTools: ["+codemode", "+tool_search"] });
      createRuntime = async ({ cwd, agentDir, sessionManager }) => {
        const services = await createAgentSessionServices({
          cwd,
          agentDir,
          modelRuntime,
          settingsManager,
          resourceLoaderOptions: {
            extensionFactories: [
              createCodemodeExtension({ mode: "on" }),
              createToolSearchExtension(),
              (pi) =>
                pi.registerMcpServer("fixture", {
                  url: `http://127.0.0.1:${port}/mcp`,
                  exposure: "codemode",
                }),
              createMcpExtension(),
            ],
          },
        });
        return {
          ...(await createAgentSessionFromServices({
            services,
            sessionManager,
            model: faux.getModel(),
          })),
          services,
          diagnostics: services.diagnostics,
        };
      };
      runtime = await createAgentSessionRuntime(createRuntime, {
        cwd: dir,
        agentDir,
        sessionManager: manager,
      });
      session = runtime.session;
      session.subscribe((e) => {
        events.push(e);
        if (e.type === "tool_execution_end" && e.toolName === "mcp__fixture__echo")
          terminated.release(e);
      });
      await session.bindExtensions({});
      // The MCP connection starts on session_start. Wait for inventory through a session prompt,
      // rather than assuming a fixed startup delay.
    },
    promptCodemode() {
      return session.prompt("Explore the fixture via codemode");
    },
    async openChild() {
      const child = await createAgentSessionRuntime(createRuntime, {
        cwd: dir,
        agentDir,
        sessionManager: SessionManager.inMemory(),
      });
      await child.session.bindExtensions({});
      return child;
    },
    scriptNext() {
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("codemode", { code: script })),
        fauxAssistantMessage("complete"),
      ]);
    },
    reload() {
      return SessionManager.open(manager.getSessionFile());
    },
    diagnostics() {
      return events.filter(
        (e) =>
          e.type === "extension_error" ||
          e.type === "message_end" ||
          e.type === "extension_notification",
      );
    },
    async trace(name, error) {
      try {
        const sanitized = {
          error: String(error),
          requests,
          events: events.map((e) => ({
            type: e.type,
            toolName: e.toolName,
            parentToolCallId: e.parentToolCallId,
          })),
          entries: manager.getEntries().map((e) => ({
            type: e.type,
            role: e.message?.role,
            toolName: e.message?.toolName,
            nestedCalls: e.message?.nestedCalls,
          })),
        };
        const path = join(tmpdir(), `embedded-pi-${name}-${dir.split("/").at(-1)}.json`);
        await writeFile(path, JSON.stringify(sanitized, null, 2));
        console.error(`Sanitized failure trace: ${path}`);
      } catch (traceError) {
        console.error(`Trace write failed: ${String(traceError)}`);
      }
    },
    close() {
      if (closePromise) return closePromise;
      blocked.release();
      startupBlocked.release();
      closePromise = (async () => {
        try {
          await runtime?.dispose();
        } finally {
          server.closeAllConnections();
          await new Promise((resolve) => server.close(resolve));
          await rm(dir, { recursive: true, force: true });
        }
      })().catch((error) => {
        closePromise = undefined;
        throw error;
      });
      return closePromise;
    },
  };
  return fixture;
}

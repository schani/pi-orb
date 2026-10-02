import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getSubagentsService } from "@gotgenes/pi-subagents";
import upstreamSubagents from "@gotgenes/pi-subagents/extension";
import { NoSimulationTask } from "determined";
import { createOrbMcpExtension } from "../../../apps/orb-runtime/src/mcp/native.ts";
import {
  activateCodemode,
  createOrbExtensions,
} from "../../../apps/orb-runtime/src/pi/extensions/index.ts";
import observer from "./owned-context-observer.mjs";
import { approvedWorkerTools, writeWorkerProfile } from "./owned-context-worker.mjs";

const key = Symbol.for("pi-orb:owned-context-qualification");
const modelId = "gpt-6.1-sol";
const credentials = new Map();
const inMemoryCredentials = {
  read: async (id) => credentials.get(id),
  list: async () => [],
  modify: async (id, fn) => {
    const value = await fn(credentials.get(id));
    if (value !== undefined) credentials.set(id, value);
    return value;
  },
  delete: async (id) => {
    credentials.delete(id);
  },
};

async function runProfiles(
  profiles,
  {
    childType = "owned-context-worker",
    invokeChild = false,
    executionKind = "codemode",
    delayedChildDiscovery = false,
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "owned-context-child-"));
  const agentDir = join(dir, "agent");
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const calls = [];
  const discoveryGate = Promise.withResolvers();
  const discoveryReached = Promise.withResolvers();
  const server = createServer(async (request, response) => {
    if (request.method === "DELETE") return void response.writeHead(204).end();
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (!chunks.length) return void response.writeHead(405).end();
    const message = JSON.parse(Buffer.concat(chunks).toString());
    calls.push({ path: request.url, method: message.method });
    if (
      delayedChildDiscovery &&
      message.method === "tools/list" &&
      request.url === "/cloudflare" &&
      calls.filter((call) => call.method === "tools/list" && call.path === "/cloudflare").length ===
        2
    ) {
      discoveryReached.resolve();
      await discoveryGate.promise;
    }
    if (message.id === undefined) return void response.writeHead(202).end();
    const count = request.url === "/cloudflare" ? 3 : 33;
    const result =
      message.method === "tools/call"
        ? { content: [{ type: "text", text: "MCP_CHILD_READ_OK" }] }
        : message.method === "initialize"
          ? {
              protocolVersion: "2025-06-18",
              serverInfo: { name: "fixture", version: "1" },
              capabilities: { tools: {} },
            }
          : message.method === "tools/list"
            ? {
                tools: Array.from({ length: count }, (_, index) => ({
                  name: `read_${index}`,
                  description: `Read ${index}`,
                  inputSchema: { type: "object", properties: {} },
                })),
              }
            : { content: [] };
    response
      .writeHead(200, { "content-type": "application/json", "mcp-session-id": "fixture-session" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  let session;
  let service;
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await mkdir(agentDir);
    await writeFile(
      join(agentDir, "auth.json"),
      JSON.stringify({ "offline-qualification": { type: "api_key", key: "fixture-only" } }),
    );
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }),
    );
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const runtime = await ModelRuntime.create({
      credentials: inMemoryCredentials,
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const providerPayloads = [];
    runtime.registerProvider("offline-qualification", {
      baseUrl: "https://must-not-connect.invalid",
      api: "owned-offline",
      streamSimple: (model, context, options) => {
        const sessionId = options?.sessionId;
        assert.ok(sessionId, "provider request must identify its SDK session");
        const child =
          Boolean(globalThis[key]?.rootSessionId) && sessionId !== globalThis[key].rootSessionId;
        providerPayloads.push({
          profile: globalThis[key]?.profile,
          child,
          tools: context.messages.flatMap((message) =>
            message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : [],
          ),
          codemode: context.messages.flatMap((message) =>
            message.role === "system"
              ? (message.toolsAdded ?? [])
                  .filter((tool) => tool.name === "codemode")
                  .map((tool) => tool.description)
              : [],
          ),
          inventory: context.messages
            .filter((message) => message.role === "system")
            .map((message) => message.sections?.mcp_servers ?? "")
            .join("\n"),
        });
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          const toolCall = child && invokeChild && !globalThis[key].childToolCalled;
          if (toolCall) globalThis[key].childToolCalled = true;
          const message = {
            role: "assistant",
            content: toolCall
              ? [
                  {
                    type: "toolCall",
                    id: "child-native-read",
                    name: executionKind === "direct" ? "mcp__cloudflare__read_0" : "codemode",
                    arguments:
                      executionKind === "direct"
                        ? {}
                        : {
                            code: 'try { const result = await tools.mcp__cloudflare__read_0({}); text(result.isError ? "DENIED_CHILD_READ:" + result.content.map((item) => item.text).join(" ") : result.content[0].text); } catch (error) { text("DENIED_CHILD_READ:" + String(error)); }',
                          },
                  },
                ]
              : [{ type: "text", text: "done" }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: toolCall ? "toolUse" : "stop",
            timestamp: 1,
          };
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: message.stopReason, message });
          stream.end(message);
        });
        return stream;
      },
      models: [
        {
          id: modelId,
          name: modelId,
          reasoning: false,
          input: ["text"],
          contextWindow: 128000,
          maxTokens: 1024,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    });
    await runtime.setRuntimeApiKey("offline-qualification", "fixture-only");
    const results = [];
    for (const profile of profiles) {
      const state = {
        profile,
        childRun: false,
        childToolCalled: false,
        allowChildCodemode: invokeChild,
        rootSessionId: "",
        records: [],
        started: new Set(),
        searches: {},
        denied: {},
        modelVerified: {},
        discovered: {},
        completed: {},
      };
      globalThis[key] = state;
      const settings = SettingsManager.inMemory({
        retry: { enabled: false },
        compaction: { enabled: false },
      });
      const bus = createEventBus();
      const configs =
        profile === "root"
          ? ["cloudflare", "datadog"].map((name) => ({
              name,
              url: `http://127.0.0.1:${port}/${name}`,
              headers: {},
            }))
          : [];
      let mcpFactories = 0;
      const mcp = createOrbMcpExtension({
        configs,
        secrets: {},
        broker: {
          controlPlaneUrl: "https://must-not-connect.invalid",
          runtimeToken: "fixture-only",
        },
        task: new NoSimulationTask("offline-child", false),
      });
      const previewSettings = SettingsManager.inMemory({
        retry: { enabled: false },
        compaction: { enabled: false },
      });
      const previewLoader = new DefaultResourceLoader({
        cwd: dir,
        agentDir,
        settingsManager: previewSettings,
        extensionFactories: [
          ...createOrbExtensions({ cwd: dir, mcp }),
          {
            name: "qualification:preview-guard",
            factory: (pi) =>
              pi.on("tool_call", () => {
                state.denied.preview = (state.denied.preview ?? 0) + 1;
                return {
                  block: true,
                  terminate: true,
                  reason: "Qualification permits no model tool calls",
                };
              }),
          },
        ],
        noSkills: true,
        noContextFiles: true,
        noPromptTemplates: true,
      });
      await previewLoader.reload();
      const { session: preview } = await createAgentSession({
        cwd: dir,
        agentDir,
        modelRuntime: runtime,
        model: runtime.getModel("offline-qualification", modelId),
        settingsManager: previewSettings,
        resourceLoader: previewLoader,
        sessionManager: SessionManager.inMemory(),
      });
      try {
        await preview.bindExtensions({});
        assert.equal(activateCodemode(preview).isOk(), true);
        await preview.prompt("Fixture profile inventory; no tools");
        assert.equal(state.denied.preview ?? 0, 0);
        const names = approvedWorkerTools(preview.getAllTools(), profile === "root");
        assert.ok(names);
        await writeWorkerProfile(dir, names);
      } finally {
        await preview.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        preview.dispose();
      }
      providerPayloads.length = 0;
      calls.length = 0;
      if (childType === "restricted-general-purpose") {
        await mkdir(join(dir, ".pi", "agents"), { recursive: true });
        await writeFile(
          join(dir, ".pi", "agents", "general-purpose.md"),
          "---\nname: general-purpose\ndescription: restricted fixture\ntools: read\n---\nFixture child.",
        );
      }
      const childExtensions = [
        ...createOrbExtensions({
          cwd: dir,
          mcp: (pi) => {
            mcpFactories++;
            return mcp(pi);
          },
        }),
        { name: "qualification:observer", factory: observer },
      ];
      const loader = new DefaultResourceLoader({
        cwd: dir,
        agentDir,
        settingsManager: settings,
        eventBus: bus,
        extensionFactories: [
          {
            name: "qualification:subagents",
            factory: (pi) => upstreamSubagents(pi, { cwd: dir, childExtensions }),
          },
          ...childExtensions,
        ],
        noSkills: true,
        noContextFiles: true,
        noPromptTemplates: true,
      });
      try {
        await loader.reload();
        assert.deepEqual(loader.getExtensions().errors, []);
        ({ session } = await createAgentSession({
          cwd: dir,
          agentDir,
          modelRuntime: runtime,
          model: runtime.getModel("offline-qualification", modelId),
          settingsManager: settings,
          resourceLoader: loader,
          sessionManager: SessionManager.inMemory(),
        }));
        state.rootSessionId = session.sessionManager.getSessionId();
        await session.bindExtensions({});
        assert.equal(activateCodemode(session).isOk(), true);
        await session.prompt("Fixture root turn; no tools");
        if (profile === "root") {
          for (const query of ["cloudflare account", "datadog monitor"]) {
            const result = await session
              .getToolDefinition("tool_search")
              .execute(`fixture-${query}`, { query });
            assert.match(result.content[0].text, /^Loaded [1-9][0-9]* tools\./);
            state.searches.root ??= {};
            state.searches.root[query] = 1;
          }
          await session.prompt("Fixture after search; no tools");
        }
        service = getSubagentsService();
        assert.ok(service);
        state.childRun = true;
        const childId = await service.spawn(
          childType === "restricted-general-purpose" ? "general-purpose" : childType,
          "Fixture child; no tools",
          {
            model: `offline-qualification/${modelId}`,
            maxTurns: 3,
            inheritContext: false,
            foreground: false,
          },
        );
        if (delayedChildDiscovery) {
          await discoveryReached.promise;
          assert.equal(calls.filter((call) => call.method === "tools/call").length, 0);
          discoveryGate.resolve();
        }
        await service.waitForAll();
        const childProfile = profile === "root" ? "child" : "baseline_child";
        const transcript = await readFile(service.getRecord(childId).outputFile, "utf8");
        const toolResults = transcript
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .filter((entry) => entry.type === "message" && entry.message?.role === "toolResult")
          .map((entry) => entry.message);
        const result = {
          profile,
          status: service.getRecord(childId)?.status,
          error: service.getRecord(childId)?.error,
          root: state.discovered[profile],
          child: state.discovered[childProfile],
          childStarted: state.started.has(childProfile),

          records: state.records.map((record) => ({
            profile: record.profile,
            kind: record.kind,
            phase: record.phase,
            activeMcpToolCount: record.activeMcpToolCount,
            codemodeActive: record.codemodeActive,
          })),
          calls,
          mcpFactories,
          payloads: providerPayloads
            .filter((payload) => payload.profile === profile)
            .map((payload) => ({
              child: payload.child,
              activeMcp: payload.tools.filter((name) => name.startsWith("mcp__")).length,
              codemode: payload.tools.includes("codemode"),
              childInventory:
                payload.codemode.some((description) => description?.includes("ALL_TOOLS")) &&
                payload.inventory.includes("mcp__cloudflare (codemode)") &&
                payload.inventory.includes("mcp__datadog (codemode)"),
              childNamespace: payload.inventory.includes("mcp__cloudflare__read_0"),
            })),
        };
        results.push(result);
        assert.equal(result.status, "completed", JSON.stringify(result));
        assert.equal(result.childStarted, true, JSON.stringify(result));
        assert.equal(result.mcpFactories, 2, JSON.stringify(result));
        assert.deepEqual(
          result.root,
          profile === "root" ? { cloudflare: 3, datadog: 33 } : { cloudflare: 0, datadog: 0 },
          JSON.stringify(result),
        );
        assert.deepEqual(
          result.child,
          profile === "root" && childType !== "restricted-general-purpose"
            ? { cloudflare: 3, datadog: 33 }
            : { cloudflare: 0, datadog: 0 },
          JSON.stringify(result),
        );
        const childPayload = result.payloads.find((payload) => payload.child);
        assert.ok(childPayload, JSON.stringify(result));
        assert.equal(childPayload.codemode, true);
        if (profile === "root" && childType !== "restricted-general-purpose")
          assert.equal(childPayload.childInventory, true, JSON.stringify(result));
        if (invokeChild) {
          assert.equal(state.childToolCalled, true);
          assert.equal(toolResults.length, 1, transcript);
          const [toolResult] = toolResults;
          const content = toolResult.content
            .filter((item) => item.type === "text")
            .map((item) => item.text)
            .join("\n");
          if (childType === "restricted-general-purpose") {
            assert.equal(childPayload.activeMcp, 0);
            assert.equal(childPayload.childNamespace, false);
            if (executionKind === "direct") {
              assert.equal(toolResult.isError, true, JSON.stringify(toolResult));
              assert.ok(content.length > 0, JSON.stringify(toolResult));
            } else {
              assert.match(content, /DENIED_CHILD_READ:/, JSON.stringify(toolResult));
            }
            assert.doesNotMatch(content, /MCP_CHILD_READ_OK/);
          } else {
            assert.equal(toolResult.isError, false, JSON.stringify(toolResult));
            assert.match(content, /MCP_CHILD_READ_OK/);
          }
          assert.equal(
            result.calls.filter((call) => call.method === "tools/call").length,
            childType === "general-purpose" ? 1 : 0,
          );
        }
        if (!invokeChild)
          assert.equal(
            result.calls.filter((call) => call.method === "tools/call").length,
            0,
            JSON.stringify(result),
          );
        assert.equal(
          result.records.findLast((record) => record.profile === childProfile)?.codemodeActive,
          true,
        );
        for (const name of ["cloudflare", "datadog"])
          assert.equal(
            result.calls.filter((call) => call.path === `/${name}` && call.method === "tools/list")
              .length,
            profile === "root" ? 2 : 0,
            JSON.stringify(result),
          );
      } finally {
        discoveryGate.resolve();
        if (service) await service.waitForAll();
        if (session) {
          await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
          session.dispose();
          session = undefined;
        }
        service = undefined;
      }
    }
    return results;
  } finally {
    delete globalThis[key];
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

test("default general-purpose child calls independently discovered native MCP through codemode", async () => {
  await runProfiles(["root"], {
    childType: "general-purpose",
    invokeChild: true,
    delayedChildDiscovery: true,
  });
});

test("explicitly restricted general-purpose override cannot call native MCP directly", async () => {
  await runProfiles(["root"], {
    childType: "restricted-general-purpose",
    invokeChild: true,
    executionKind: "direct",
  });
});

test("explicitly restricted general-purpose override cannot call native MCP through codemode", async () => {
  await runProfiles(["root"], { childType: "restricted-general-purpose", invokeChild: true });
});

test("general-purpose child with an empty approved catalog exposes no native MCP tools", async () => {
  const [result] = await runProfiles(["independent_empty_baseline"], {
    childType: "general-purpose",
  });
  assert.deepEqual(result.child, { cloudflare: 0, datadog: 0 });
  assert.equal(result.calls.filter((call) => call.method === "tools/list").length, 0);
});

test("fresh authenticated custom vendor child lists and exposes 36 native tools", async () => {
  assert.equal((await runProfiles(["root"])).length, 1);
});

test("sequential baseline does not leak its worker profile into authenticated child", async () => {
  const results = await runProfiles(["independent_empty_baseline", "root"]);
  assert.deepEqual(results[0].child, { cloudflare: 0, datadog: 0 });
  assert.deepEqual(results[1].child, { cloudflare: 3, datadog: 33 });
});

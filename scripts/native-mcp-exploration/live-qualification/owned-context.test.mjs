import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createMcpExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { NoSimulationTask } from "determined";
import {
  createOrbMcpExtension,
  nativeMcpConfig,
} from "../../../apps/orb-runtime/src/mcp/native.ts";
import {
  activateCodemode,
  createOrbExtensions,
} from "../../../apps/orb-runtime/src/pi/extensions/index.ts";
import { approvedCatalog } from "./owned-context.ts";
import observer, { qualifiesMeasurement, successfulAssistant } from "./owned-context-observer.mjs";
import {
  contextToolPolicy,
  deniedSearchShape,
  failureDiagnostic,
  summarizeContextRecords,
} from "./owned-context-policy.mjs";

test("the model catalog fence admits only the owned two-server revision", () => {
  const catalog = {
    revision: 1,
    servers: [
      {
        name: "cloudflare",
        url: "https://mcp.cloudflare.com/mcp",
        oauth: { id: "1cfa006b-da21-4c11-9b5b-95cd28a9bf1b" },
        headers: {},
      },
      {
        name: "datadog",
        url: "https://mcp.us5.datadoghq.com/v1/mcp",
        oauth: { id: "c25b1857-1896-45cf-a427-a90cee36d125" },
        headers: {},
      },
    ],
  };
  assert.equal(approvedCatalog(catalog), true);
  assert.equal(approvedCatalog({ ...catalog, revision: 2 }), false);
  assert.equal(
    approvedCatalog({ ...catalog, servers: [catalog.servers[0], catalog.servers[0]] }),
    false,
  );
  assert.equal(
    approvedCatalog({
      ...catalog,
      servers: [
        { ...catalog.servers[0], oauth: { id: "406a3aeb-7e46-492e-b56a-07364453d511" } },
        catalog.servers[1],
      ],
    }),
    false,
  );
  assert.equal(
    approvedCatalog({
      ...catalog,
      servers: [
        { ...catalog.servers[0], headers: { Authorization: "stolen" } },
        catalog.servers[1],
      ],
    }),
    false,
  );
});
test("denied search shapes distinguish optional SDK limit from wrong query without disclosing input", () => {
  const limit = deniedSearchShape({ query: "cloudflare account", limit: 3 });
  assert.deepEqual(limit, {
    queryMatchesPolicy: false,
    queryObserved: true,
    hasLimit: true,
    onlyQueryAndLimit: true,
    limitValid: true,
  });
  assert.deepEqual(
    deniedSearchShape({
      query: "private unexpected",
      limit: "SECRET_PROVIDER_STACK_PRIVATE_CONTEXT",
      privateKey: "SECRET_PROVIDER_STACK_PRIVATE_CONTEXT",
    }),
    {
      queryMatchesPolicy: false,
      queryObserved: false,
      hasLimit: true,
      onlyQueryAndLimit: false,
      limitValid: false,
    },
  );
  assert.equal(
    JSON.stringify(deniedSearchShape({ query: "SECRET_PROVIDER_STACK_PRIVATE_CONTEXT" })).includes(
      "SECRET_PROVIDER_STACK_PRIVATE_CONTEXT",
    ),
    false,
  );
});
test("failure snapshots expose fixed bounded counts, not model/provider content", () => {
  const sentinel = "SECRET_PROVIDER_STACK_PRIVATE_CONTEXT";
  const state = {
    started: new Set(["root"]),
    discovered: { root: { cloudflare: 3, datadog: 33 } },
    searches: { root: { "cloudflare account": 1, [sentinel]: 99 } },
    denied: { root: 1 },
    deniedCategories: { root: { codemode: 1, [sentinel]: 99 } },
    deniedSearchShapes: {
      root: {
        queryMatchesPolicy: true,
        queryObserved: true,
        hasLimit: true,
        onlyQueryAndLimit: true,
        limitValid: true,
        rawInput: sentinel,
      },
    },
    completed: { root: false },
    modelVerified: { root: true },
    records: [
      {
        profile: "root",
        phase: "after_discovery",
        kind: "provider_payload",
        status: "measured",
        utf8Bytes: 42,
        codepoints: 40,
        activeMcpToolCount: 36,
        prompt: sentinel,
      },
    ],
    rawContext: sentinel,
  };
  const snapshot = failureDiagnostic(state, "root_search_prompt");
  assert.deepEqual(snapshot.profiles[0].searched, {
    "cloudflare account": 1,
    "datadog monitor": 0,
  });
  assert.deepEqual(snapshot.profiles[0].deniedCategories, {
    tool_search: 0,
    codemode: 1,
    other: 0,
  });
  assert.deepEqual(snapshot.profiles[0].deniedSearchShape, {
    queryMatchesPolicy: true,
    queryObserved: true,
    hasLimit: true,
    onlyQueryAndLimit: true,
    limitValid: true,
  });
  assert.equal(snapshot.profiles[0].completed, false);
  assert.equal(JSON.stringify(snapshot).includes(sentinel), false);
});
test("all model tool calls are denied; harness-only native searches are separate", () => {
  const policy = contextToolPolicy();
  assert.equal(policy("tool_search", { query: "cloudflare account" }), false);
  assert.equal(policy("tool_search", { query: "datadog monitor" }), false);
  assert.equal(policy("tool_search", { query: "Cloudflare account" }), false);
  assert.equal(policy("tool_search", { query: "datadog monitor search" }), false);
  assert.equal(policy("tool_search", { query: "cloudflare account", limit: 3 }), false);
  assert.equal(policy("tool_search", { query: "cloudflare delete everything" }), false);
  assert.equal(policy("tool_search", { query: "datadog write monitor" }), false);
  assert.equal(
    policy("mcp__cloudflare__execute", {
      code: "async () => { const r = await cloudflare.request({ method: 'GET', path: '/accounts', query: { per_page: 1 } }); return r; }",
    }),
    false,
  );
  assert.equal(
    policy("mcp__cloudflare__execute", {
      code: "await cloudflare.request({method:'DELETE', path:'/accounts'})",
    }),
    false,
  );
  assert.equal(policy("mcp__datadog__search_datadog_monitors", { query: "status:alert" }), false);
  for (const name of ["bash", "read", "codemode", "subagent", "mcp__cloudflare__delete"])
    assert.equal(policy(name, {}), false);
});
test("real native empty-catalog SDK request advertises codemode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "owned-context-native-tool-decls-"));
  let session;
  try {
    const credentials = new Map();
    const runtime = await ModelRuntime.create({
      credentials: {
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
      },
      modelsPath: null,
      refreshOnCreate: false,
    });
    let observed;
    runtime.registerProvider("offline-qualification", {
      baseUrl: "https://must-not-connect.invalid",
      api: "offline-qualification",
      streamSimple: (_model, context) => {
        const names = context.messages.flatMap((message) =>
          message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : [],
        );
        observed = {
          directToolSearchAdvertised: names.includes("tool_search"),
          codemodeAdvertised: names.includes("codemode"),
        };
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          const message = {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            api: "offline-qualification",
            provider: "offline-qualification",
            model: "probe",
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 1,
          };
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: "stop", message });
          stream.end(message);
        });
        return stream;
      },
      models: [
        {
          id: "probe",
          name: "probe",
          reasoning: false,
          input: ["text"],
          contextWindow: 128000,
          maxTokens: 1024,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    });
    await runtime.setRuntimeApiKey("offline-qualification", "fixture-only");
    const settings = SettingsManager.inMemory({
      retry: { enabled: false },
      compaction: { enabled: false },
    });
    assert.equal(settings.getRetryEnabled(), false);
    assert.equal(settings.getCompactionEnabled(), false);
    const mcp = createOrbMcpExtension({
      configs: [],
      secrets: {},
      broker: { controlPlaneUrl: "https://must-not-connect.invalid", runtimeToken: "fixture-only" },
      task: new NoSimulationTask("owned-context-offline-mcp", false),
    });
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager: settings,
      extensionFactories: createOrbExtensions({ cwd: dir, mcp }),
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
    });
    await loader.reload();
    assert.equal(settings.getRetryEnabled(), false);
    assert.equal(settings.getCompactionEnabled(), false);
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({
      cwd: dir,
      agentDir: dir,
      modelRuntime: runtime,
      model: runtime.getModel("offline-qualification", "probe"),
      settingsManager: settings,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
    }));
    await session.bindExtensions({});
    assert.equal(activateCodemode(session).isOk(), true);
    await session.prompt("Fixture turn");
    assert.deepEqual(
      {
        observed,
        stopReason: session.messages.findLast((message) => message.role === "assistant")
          ?.stopReason,
        activeSearch: session.getActiveToolNames().includes("tool_search"),
        activeCodemode: session.getActiveToolNames().includes("codemode"),
        availableSearch: session.getAllTools().some((tool) => tool.name === "tool_search"),
        availableCodemode: session.getAllTools().some((tool) => tool.name === "codemode"),
      },
      {
        observed: { directToolSearchAdvertised: false, codemodeAdvertised: true },
        stopReason: "stop",
        activeSearch: false,
        activeCodemode: true,
        availableSearch: true,
        availableCodemode: true,
      },
    );
  } finally {
    if (session) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("connected native 36-tool independent SDK sessions advertise codemode with persistent settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "owned-context-connected-"));
  const server = createServer(async (request, response) => {
    if (request.method === "GET") {
      response.writeHead(405).end();
      return;
    }
    if (request.method === "DELETE") {
      response.writeHead(204).end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString());
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const count = request.url === "/cloudflare" ? 3 : 33;
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: "2025-06-18",
            serverInfo: { name: "fixture", version: "1" },
            capabilities: { tools: {} },
          }
        : message.method === "tools/list"
          ? {
              tools: Array.from({ length: count }, (_, i) => ({
                name: `read_${i}`,
                inputSchema: { type: "object", properties: {} },
              })),
            }
          : { content: [] };
    response
      .writeHead(200, { "content-type": "application/json", "mcp-session-id": "fixture-session" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  let session;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const configs = ["cloudflare", "datadog"].map((name) => ({
      name,
      url: `http://127.0.0.1:${port}/${name}`,
      headers: {},
    }));
    const agentDir = join(dir, "agent");
    await mkdir(agentDir);
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }),
    );
    const credentials = new Map();
    const runtime = await ModelRuntime.create({
      credentials: {
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
      },
      modelsPath: null,
      refreshOnCreate: false,
    });
    const observed = [];
    runtime.registerProvider("offline-qualification", {
      baseUrl: "https://must-not-connect.invalid",
      api: "offline-qualification",
      streamSimple: (model, context) => {
        observed.push(
          context.messages.flatMap((message) =>
            message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : [],
          ),
        );
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          const message = {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
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
            stopReason: "stop",
            timestamp: 1,
          };
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: "stop", message });
          stream.end(message);
        });
        return stream;
      },
      models: [
        {
          id: "probe",
          name: "probe",
          reasoning: false,
          input: ["text"],
          contextWindow: 128000,
          maxTokens: 1024,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    });
    await runtime.setRuntimeApiKey("offline-qualification", "fixture-only");
    for (const label of ["root-profile", "child-profile"]) {
      const mcp = createMcpExtension({ loadConfig: () => nativeMcpConfig(configs) });
      const settings = SettingsManager.create(dir, agentDir);
      const loader = new DefaultResourceLoader({
        cwd: dir,
        agentDir,
        settingsManager: settings,
        extensionFactories: createOrbExtensions({ cwd: dir, mcp }),
        noSkills: true,
        noContextFiles: true,
        noPromptTemplates: true,
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      ({ session } = await createAgentSession({
        cwd: dir,
        agentDir,
        modelRuntime: runtime,
        model: runtime.getModel("offline-qualification", "probe"),
        settingsManager: settings,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(),
      }));
      await session.bindExtensions({});
      assert.equal(activateCodemode(session).isOk(), true);
      await session.prompt(`Fixture ${label}`);
      assert.equal(
        session.getAllTools().filter((tool) => tool.name.startsWith("mcp__")).length,
        36,
      );
      if (label === "root-profile") {
        const nativeSearch = session.getToolDefinition("tool_search");
        assert.ok(nativeSearch);
        const cloudflareSearch = await nativeSearch.execute("approved-offline-cloudflare", {
          query: "cloudflare account",
        });
        const datadogSearch = await nativeSearch.execute("approved-offline-datadog", {
          query: "datadog monitor",
        });
        assert.match(cloudflareSearch.content[0].text, /^Loaded 3 tools\./);
        assert.match(datadogSearch.content[0].text, /^Loaded [1-9][0-9]* tools\./);
        await session.prompt("After root native discovery");
        assert.equal(observed.at(-1).filter((name) => name.startsWith("mcp__")).length, 11);
      } else {
        assert.equal(observed.at(-1).filter((name) => name.startsWith("mcp__")).length, 0);
      }
      assert.equal(observed.at(-1).includes("codemode"), true);
      assert.equal(observed.at(-1).includes("tool_search"), false);
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
      session = undefined;
    }
    assert.equal(observed.length, 3);
  } finally {
    if (session) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test("real SDK model turns install the observer and block denied tool calls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "owned-context-sdk-"));
  const key = Symbol.for("pi-orb:owned-context-qualification");
  const state = {
    profile: "independent_empty_baseline",
    rootSessionId: "",
    records: [],
    started: new Set(),
    searches: {},
    denied: {},
    discovered: {},
    completed: {},
  };
  globalThis[key] = state;
  let session;
  try {
    const credentials = new Map();
    const runtime = await ModelRuntime.create({
      credentials: {
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
      },
      modelsPath: null,
      refreshOnCreate: false,
    });
    let turn = 0;
    runtime.registerProvider("offline-qualification", {
      baseUrl: "https://must-not-connect.invalid",
      api: "offline-qualification",
      streamSimple: (model) => {
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          const currentTurn = turn++;
          const content =
            currentTurn === 0
              ? [
                  {
                    type: "toolCall",
                    id: "denied-call",
                    name: "bash",
                    arguments: { command: "echo forbidden" },
                  },
                ]
              : [{ type: "text", text: "done" }];
          const message = {
            role: "assistant",
            content,
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
            stopReason:
              currentTurn === 2 ? "error" : content[0].type === "toolCall" ? "toolUse" : "stop",
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
          id: "probe",
          name: "probe",
          reasoning: false,
          input: ["text"],
          contextWindow: 128000,
          maxTokens: 1024,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    });
    await runtime.setRuntimeApiKey("offline-qualification", "fixture-only");
    assert.equal(existsSync(join(dir, "auth.json")), false);
    const settings = SettingsManager.inMemory({
      retry: { enabled: false },
      compaction: { enabled: false },
    });
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager: settings,
      extensionFactories: [{ name: "qualification:observer", factory: observer }],
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({
      cwd: dir,
      agentDir: dir,
      modelRuntime: runtime,
      model: runtime.getModel("offline-qualification", "probe"),
      settingsManager: settings,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
    }));
    state.rootSessionId = session.sessionManager.getSessionId();
    await session.bindExtensions({});
    await session.prompt("Fixture turn");
    assert.equal(state.started.has("independent_empty_baseline"), true);
    assert.equal(state.denied.independent_empty_baseline, 1);
    assert.equal(
      state.records.some((record) => record.kind === "transcript" && record.status === "measured"),
      true,
    );
    // A scripted stream bypasses provider serialization; verify its SDK hook separately.
    const payload = { messages: [{ content: "private fixture" }] };
    await session.extensionRunner.emitBeforeProviderRequest(payload);
    assert.equal(
      state.records.some(
        (record) => record.kind === "provider_payload" && record.status === "measured",
      ),
      true,
    );
    const captured = state.records.find((record) => record.kind === "provider_payload");
    assert.deepEqual(captured.discovered, { cloudflare: 0, datadog: 0 });
    assert.deepEqual(captured.searched, {});
    assert.equal(captured.modelVerified, false);
    assert.equal(JSON.stringify(state.records).includes("Fixture turn"), false);
    assert.equal(state.completed.independent_empty_baseline, false); // Offline model is not Sol.
    await session.prompt("Scripted provider error");
    assert.equal(state.completed.independent_empty_baseline, false);
    assert.equal(
      successfulAssistant(session.messages.findLast((message) => message.role === "assistant")),
      false,
    );
  } finally {
    if (session) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
    delete globalThis[key];
    await rm(dir, { recursive: true, force: true });
  }
});

test("payload evidence is sampled at request time, with exact inventories and both successful searches", () => {
  const base = {
    profile: "root",
    kind: "provider_payload",
    status: "measured",
    modelVerified: true,
    codemodeActive: true,
    discovered: { cloudflare: 3, datadog: 33 },
    searched: { "cloudflare account": 1, "datadog monitor": 1 },
    deniedCalls: 0,
  };
  const valid = { ...base, phase: "after_search" };
  assert.equal(qualifiesMeasurement(valid, "root", "after_search"), true);
  for (const change of [
    { discovered: { cloudflare: 2, datadog: 33 } },
    { discovered: { cloudflare: 3, datadog: 0 } },
    { searched: { "cloudflare account": 1 } },
    { phase: "after_discovery" },
    { modelVerified: false },
    { codemodeActive: false },
    { deniedCalls: 1 },
    { status: "unavailable" },
  ])
    assert.equal(qualifiesMeasurement({ ...valid, ...change }, "root", "after_search"), false);
  assert.equal(
    qualifiesMeasurement(
      { ...base, phase: "after_discovery", searched: {} },
      "root",
      "after_discovery",
    ),
    true,
  );
  assert.equal(
    qualifiesMeasurement(
      { ...base, phase: "before_discovery", discovered: { cloudflare: 3, datadog: 0 } },
      "root",
      "after_discovery",
    ),
    false,
  );
  assert.equal(
    qualifiesMeasurement(
      {
        ...base,
        profile: "independent_empty_baseline",
        phase: "before_discovery",
        discovered: { cloudflare: 0, datadog: 0 },
        searched: {},
      },
      "independent_empty_baseline",
      "before_discovery",
    ),
    true,
  );
  assert.equal(
    qualifiesMeasurement(
      { ...base, profile: "child", phase: "after_discovery", searched: {} },
      "child",
      "after_discovery",
    ),
    true,
  );
  assert.equal(
    qualifiesMeasurement(
      {
        ...base,
        profile: "child",
        phase: "after_discovery",
        discovered: { cloudflare: 0, datadog: 0 },
        searched: {},
      },
      "child",
      "after_discovery",
    ),
    false,
  );
  assert.equal(
    qualifiesMeasurement(
      { ...base, profile: "child", phase: "after_search", searched: {} },
      "child",
      "after_search",
    ),
    false,
  );
  assert.equal(
    qualifiesMeasurement(
      { ...base, profile: "independent_empty_baseline", phase: "before_discovery" },
      "independent_empty_baseline",
      "before_discovery",
    ),
    false,
  );
});
test("assistant success requires selected Sol and completed stop, never tool-use, error, or abort", () => {
  const message = {
    role: "assistant",
    provider: "openai-codex",
    model: "gpt-6.1-sol",
    stopReason: "stop",
  };
  assert.equal(successfulAssistant(message), true);
  for (const change of [
    { stopReason: "error" },
    { stopReason: "aborted" },
    { stopReason: "toolUse" },
    { model: "other" },
    { provider: "other" },
  ])
    assert.equal(successfulAssistant({ ...message, ...change }), false);
});
test("context output preserves only bounded measurements, never raw bodies or provider records", () => {
  const result = summarizeContextRecords([
    {
      profile: "root",
      phase: "after_discovery",
      kind: "provider_payload",
      status: "measured",
      utf8Bytes: 200,
      codepoints: 195,
      activeMcpToolCount: 0,
      secret: "BEARER",
    },
  ]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], {
    profile: "root",
    phase: "after_discovery",
    kind: "provider_payload",
    status: "measured",
    utf8Bytes: 200,
    codepoints: 195,
    activeMcpToolCount: 0,
  });
});

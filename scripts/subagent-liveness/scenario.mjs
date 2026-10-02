import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ResultAsync } from "neverthrow";
import { assertSubagentActivity } from "../../apps/orb-runtime/src/testkit/subagent-contract.ts";

// Executable characterization test. Assertion exceptions are the test framework
// contract, not recoverable domain errors. Third-party promise failures are
// captured at each call boundary by checked(). No production adapter is changed.
async function checked(promise) {
  const result = await ResultAsync.fromPromise(promise, (error) => ({ message: String(error) }));
  assert.equal(result.isOk(), true, result.isErr() ? result.error.message : "");
  return result.value;
}

function gate() {
  const { promise, resolve } = Promise.withResolvers();
  return { promise, resolve };
}

const scenario = process.env.SCENARIO;
const useRuntime = process.env.USE_RUNTIME === "1";
const toolModelScenario = scenario.startsWith("model-tool");
const profileModelScenario = scenario.endsWith("profile") && scenario.startsWith("model-");
const lockedModelScenario = scenario.endsWith("locked") && scenario.startsWith("model-");
const modelPolicyScenario =
  toolModelScenario || profileModelScenario || lockedModelScenario || scenario === "model-inherit";
const expectedPolicyModel =
  scenario === "model-inherit"
    ? { provider: "liveness-probe", id: "probe" }
    : { provider: "openai-codex", id: "gpt-6.1-sol" };
// The characterization install must not shadow production's SDK when both
// locked dependency trees are present (the README deliberately installs both).
const sdk = useRuntime
  ? await checked(import("../../apps/orb-runtime/src/testkit/pi-sdk.ts"))
  : await checked(import("@earendil-works/pi-coding-agent"));
const {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} = sdk;
const { createAssistantMessageEventStream } = useRuntime
  ? sdk
  : await checked(import("@earendil-works/pi-ai"));
if (useRuntime) {
  const actual = await checked(import("../../apps/orb-runtime/src/testkit/pi-sdk.ts"));
  assert.equal(
    ModelRuntime === actual.ModelRuntime,
    true,
    "characterization dependencies shadowed the production SDK",
  );
}
const credentialScenario = scenario === "credential-refresh" || scenario === "credential-failure";
let rootExtensionStarts = 0;
const summaryInputs = [];
let inboxHandled = false;
let inboxDelivery;
let brokerGrants = 0;
let rejectChildRefresh = scenario === "credential-failure";
const { PiOrbAgent } = useRuntime ? await import("../../apps/orb-runtime/src/pi/agent.ts") : {};
const { createOrbExtensions } = useRuntime
  ? await import("../../apps/orb-runtime/src/pi/extensions/index.ts")
  : {};
const loadFailure = scenario === "mcp-load-failure";
const mcpScenario =
  scenario === "mcp" ||
  scenario === "mcp-shutdown" ||
  scenario === "mcp-profile" ||
  scenario === "mcp-cancel-starting" ||
  loadFailure;
const cancelStarting = scenario === "cancel-starting" || scenario === "mcp-cancel-starting";
const useMcpTool = mcpScenario && scenario !== "mcp-profile";
const shutdownScenario = scenario === "shutdown-running" || scenario === "mcp-shutdown";
let mcpFixture;
let mcp;
const root = process.env.FIXTURE_ROOT;
// Embedded runtime cwd differs from its checkout. Profile/settings discovery
// must use the explicitly supplied session cwd, as the browser E2E does.
if (mcpScenario) process.chdir(fileURLToPath(new URL("../../", import.meta.url)));
const agentDir = process.env.PI_CODING_AGENT_DIR;
mkdirSync(join(agentDir, "agents"), { recursive: true });
mkdirSync(join(agentDir, "extensions"), { recursive: true });
writeFileSync(
  join(agentDir, "extensions", "probe.ts"),
  readFileSync(join(import.meta.dirname, "probe-extension.ts")),
);
writeFileSync(
  join(agentDir, "agents", "probe.md"),
  `---\nname: probe\ndescription: Deterministic liveness child\ntools: ${useMcpTool ? "mcp__approved__probe" : "probe_gate"}\n${profileModelScenario || lockedModelScenario ? "model: SoL\n" : ""}${lockedModelScenario || scenario === "model-inherit" ? "locked: [model]\n" : ""}---\nExecute the test task.\n`,
);
writeFileSync(
  join(agentDir, "settings.json"),
  JSON.stringify({
    defaultProjectTrust: "never",
    retry: { enabled: false },
    compaction: { enabled: false },
  }),
);
writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({ maxConcurrent: 1 }));

const runtime = useRuntime
  ? new PiOrbAgent({
      orbId: "fixture",
      repositoryUrl: "https://example.com/repo",
      workDir: root,
      executionId: "fixture-host-execution",
      skillsDir: null,
      broker: null,
    })
  : null;
let session;
let service;
let manager;
const childGates = new Map([
  ["one", gate()],
  ["two", gate()],
]);
if (mcpScenario) {
  const { createMcpExtension } = await import("@earendil-works/pi-coding-agent");
  const { startNativeMcpFixture } = await import("./native-mcp-fixture.mjs");
  // Root and child receive the same approved catalog, but each native extension
  // constructs and shuts down its own SDK connection.
  mcpFixture = await startNativeMcpFixture({ gate: childGates.get("one"), note });
  mcp = createMcpExtension({
    loadConfig: () => ({
      errors: [],
      servers: [
        {
          name: "approved",
          source: "approved-boot",
          scope: "global",
          config: { url: mcpFixture.url, exposure: "direct" },
        },
      ],
    }),
  });
}
const parentGate = gate();
const followupGate = gate();
const inboxGate = gate();
const failureGate = gate();
const trace = [];
const waiters = [];
const ids = new Map();
const liveChildren = new Set();
const terminalRows = [];
let claimedParent = false;
let bridgeBusy = false;
let parentStarts = 0;
let parentSettles = 0;
let resumePhase = false;
let resumeToolSent = false;
let shuttingDown;
const activityEdges = [];

function checkBridge() {
  const next = runtime
    ? runtime.getHealth().activity === "busy"
    : claimedParent || (session !== undefined && !session.isIdle) || liveChildren.size > 0;
  if (next !== bridgeBusy) {
    bridgeBusy = next;
    activityEdges.push(next ? "busy" : "idle");
    note(`bridge:${next ? "busy" : "idle"}`);
  }
}

function note(event, details = {}) {
  const row = { event, ...details };
  trace.push(row);
  console.log(JSON.stringify(row));
  for (const waiter of [...waiters]) {
    if (waiter.predicate()) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  }
}
function until(predicate) {
  if (predicate()) return Promise.resolve();
  const pending = gate();
  waiters.push({ predicate, resolve: pending.resolve });
  return pending.promise;
}
const saw = (event) => trace.some((row) => row.event === event);
const waitEvent = async (event) => {
  await until(() => saw(event) || saw("model:error"));
  assert.equal(
    saw("model:error"),
    false,
    trace.find((row) => row.event === "model:error")?.message,
  );
};
const labelFor = (id) => [...ids].find(([, value]) => value === id)?.[0] ?? "new";
const terminalRecordExists = (id) =>
  manager
    .getEntries()
    .some(
      (entry) =>
        entry.type === "custom" && entry.customType === "subagents:record" && entry.data.id === id,
    );

globalThis[Symbol.for("pi-orb:liveness-fixture")] = { childGates, note };

runtime?.subscribe(() => checkBridge());
const bus = createEventBus();
for (const event of ["created", "started", "completed", "failed", "resumed"]) {
  bus.on(`subagents:${event}`, (data) => {
    if (event === "created" || event === "started") {
      liveChildren.add(data.id);
      checkBridge();
      note(`child:${event}`, { label: labelFor(data.id), hasRunning: service?.hasRunning() });
    } else {
      const row = {
        label: labelFor(data.id),
        lifecycle: event,
        parentIdle: session.isIdle,
        hasRunning: service.hasRunning(),
        persisted: terminalRecordExists(data.id),
        error: service.getRecord(data.id)?.error,
      };
      terminalRows.push(row);
      note("child:terminal-callback", row);
      queueMicrotask(() => {
        liveChildren.delete(data.id);
        checkBridge();
        note("child:terminal-drained", {
          label: labelFor(data.id),
          parentIdle: session.isIdle,
          persisted: terminalRecordExists(data.id),
          bridgeBusy,
        });
      });
    }
  });
}

function output(model, content, stopReason) {
  return {
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
    stopReason,
    timestamp: 1,
  };
}
const text = (value) => [{ type: "text", text: value }];
const call = (name, args) => [{ type: "toolCall", id: `call-${name}`, name, arguments: args }];
function transcriptToolNames(messages) {
  const names = new Set();
  for (const message of messages) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsAdded ?? []) names.add(tool.name);
    for (const tool of message.toolsRemoved ?? []) names.delete(tool.name);
  }
  return [...names];
}
function scriptedStream(model, context, options) {
  const stream = createAssistantMessageEventStream();
  const allText = JSON.stringify(context.messages);
  const child = transcriptToolNames(context.messages).includes("subagent")
    ? null
    : resumePhase && allText.includes("CONTINUE_CHILD")
      ? "two"
      : allText.includes("CHILD_one")
        ? "one"
        : allText.includes("CHILD_two")
          ? "two"
          : null;
  const toolResults = context.messages.filter((message) => message.role === "toolResult");
  const run = async () => {
    let message;
    if (child !== null) {
      const names = transcriptToolNames(context.messages);
      assert.ok(names.includes(useMcpTool ? "mcp__approved__probe" : "probe_gate"));
      if (useRuntime && !loadFailure)
        assert.equal(names.includes("codemode"), true, "child profile must retain codemode");
      if (scenario === "mcp-profile") assert.equal(names.includes("mcp__approved__probe"), false);
      for (const rootOnly of [
        "launch_children",
        "subagent",
        "get_subagent_result",
        "steer_subagent",
      ])
        assert.equal(names.includes(rootOnly), false);
      if (credentialScenario) assert.equal(options.apiKey === "fake-access-2", true);
      note(`model:child:${child}`, { model: model.id, provider: model.provider });
      if (modelPolicyScenario)
        assert.deepEqual({ provider: model.provider, id: model.id }, expectedPolicyModel);
      if (scenario === "parent-first" || (scenario === "resume-cancel" && resumePhase))
        assert.deepEqual(
          { provider: model.provider, id: model.id },
          { provider: "liveness-probe", id: "probe" },
        );
      if (scenario === "model-selection" || scenario === "model-unavailable")
        assert.deepEqual(
          { provider: model.provider, id: model.id },
          {
            provider: "openai-codex",
            id: child === "one" && scenario === "model-selection" ? "gpt-6.1-sol" : "gpt-6-sol",
          },
        );
      if (scenario === "mcp-profile" && toolResults.length === 1) {
        const result = JSON.stringify(toolResults[0]);
        assert.match(
          result,
          /denied:2;js:42/,
          "restricted codemode script did not deny nested tools",
        );
        note("assert:child-codemode-denies-mcp-and-bash");
      }
      message =
        scenario === "mcp-profile" && toolResults.length === 0
          ? output(
              model,
              call("codemode", {
                code: `let denied = 0;
for (const [name, args] of [["bash", {command:"echo FORBIDDEN"}], ["mcp__approved__probe", {}]]) {
  try { await tools[name](args); } catch { denied++; }
}
text("denied:" + denied + ";js:" + (6 * 7));`,
              }),
              "toolUse",
            )
          : toolResults.length === 0 ||
              (child === "two" && resumePhase && !resumeToolSent) ||
              (scenario === "mcp-profile" && toolResults.length === 1)
            ? output(
                model,
                useMcpTool
                  ? call("mcp__approved__probe", {})
                  : call("probe_gate", { label: child }),
                "toolUse",
              )
            : output(model, text(`child ${child} finished`), "stop");
      if (resumePhase) resumeToolSent = true;
    } else if (
      scenario === "inbox-child-only" &&
      allText.includes("USER_DURING_CHILD") &&
      !inboxHandled
    ) {
      inboxHandled = true;
      note("model:inbox-entered");
      await inboxGate.promise;
      message = output(model, text("parent handled inbox"), "stop");
    } else if (resumePhase) {
      message = output(
        model,
        call("subagent", {
          prompt: "CONTINUE_CHILD",
          description: "resume one",
          subagent_type: "probe",
          resume: ids.get("one"),
          ...(scenario === "resume-cancel" ? { model: "SoL" } : {}),
        }),
        "toolUse",
      );
    } else if (allText.includes("task-notification")) {
      note("model:followup-entered");
      await followupGate.promise;
      message = output(model, text("parent processed child outcome"), "stop");
    } else if (toolResults.length === 0) {
      note("model:root-launch");
      message = output(
        model,
        toolModelScenario
          ? call("subagent", {
              subagent_type: "probe",
              prompt: "CHILD_one",
              description: "one",
              run_in_background: true,
              ...(lockedModelScenario
                ? { model: "sol-new" }
                : profileModelScenario
                  ? {}
                  : { model: "SoL" }),
            })
          : call("launch_children", {}),
        "toolUse",
      );
    } else {
      assert.equal(toolResults.at(-1).isError, false, JSON.stringify(toolResults.at(-1).content));
      if (toolModelScenario) {
        const receipt = toolResults.at(-1);
        assert.equal(receipt.details.requestedModel, "SoL");
        assert.deepEqual(receipt.details.resolvedModel, expectedPolicyModel);
        if (receipt.toolName === "subagent") {
          ids.set("one", receipt.details.agentId);
          note("children:admitted");
          message = output(
            model,
            call("get_subagent_result", { agent_id: ids.get("one") }),
            "toolUse",
          );
        } else {
          assert.equal(receipt.toolName, "get_subagent_result");
          note("assert:background-and-retrieval-model-receipts");
        }
      }
      if (!message) {
        note("model:parent-final-entered");
        await parentGate.promise;
        message = output(model, text("parent finished its own turn"), "stop");
      }
    }
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: message.stopReason, message });
    stream.end();
  };
  void ResultAsync.fromPromise(run(), (error) => ({ message: String(error) })).mapErr((error) => {
    note("model:error", { message: error.message });
    const message = { ...output(model, [], "error"), errorMessage: error.message };
    stream.push({ type: "error", reason: "error", error: message });
    stream.end();
    return error;
  });
  return stream;
}

const modelRuntime = await checked(
  ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false,
  }),
);
let authConfig = { apiKey: "fake-test-key" };
if (credentialScenario) {
  const { NoSimulationTask } = await import("determined");
  const { BrokerTokenClient } = await import("../../apps/orb-runtime/src/domain/broker-client.ts");
  const { brokerProviderConfig } = await import("../../apps/orb-runtime/src/broker/provider.ts");
  const client = new BrokerTokenClient({
    async requestToken(_task, request) {
      note("broker:request", { reason: request.reason });
      if (request.reason === "expiring" && rejectChildRefresh) {
        rejectChildRefresh = false;
        return { kind: "auth_required" };
      }
      brokerGrants++;
      return {
        kind: "grant",
        grant: {
          accessToken: `fake-access-${brokerGrants}`,
          expiresAt: Date.now() + 3_600_000,
          generation: brokerGrants,
        },
      };
    },
  });
  authConfig = brokerProviderConfig(
    new NoSimulationTask("child-credential-contract", false),
    client,
    {},
  );
}
modelRuntime.registerProvider("liveness-probe", {
  ...authConfig,
  baseUrl: "https://must-not-connect.invalid",
  api: "liveness-probe",
  streamSimple: scriptedStream,
  models: [
    ...["gpt-6-sol", "gpt-6.1-sol"].map((id) => ({
      id,
      name: id,
      reasoning: false,
      input: ["text"],
      contextWindow: 128000,
      maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
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
if (credentialScenario)
  await checked(
    modelRuntime.login("liveness-probe", "oauth", {
      prompt: () => Promise.reject(new Error("Child contract must not ask for CLI login")),
      notify: () => undefined,
    }),
  );
modelRuntime.registerProvider("openai-codex", {
  ...authConfig,
  baseUrl: "https://must-not-connect.invalid",
  api: "liveness-probe",
  streamSimple: scriptedStream,
  models: (scenario === "model-unavailable" ? ["gpt-6-sol"] : ["gpt-6-sol", "gpt-6.1-sol"]).map(
    (id) => ({
      id,
      name: id,
      reasoning: false,
      input: ["text"],
      contextWindow: 128000,
      maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }),
  ),
});
await checked(modelRuntime.refresh({ allowNetwork: false }));
const model = modelRuntime.getModel("liveness-probe", "probe");
assert.ok(model);
const extensionPath = fileURLToPath(
  new URL("../index.ts", import.meta.resolve("@gotgenes/pi-subagents")),
);
const settingsManager = SettingsManager.inMemory({
  retry: { enabled: false },
  compaction: { enabled: false },
});
const loader = new DefaultResourceLoader({
  cwd: root,
  agentDir,
  settingsManager,
  eventBus: bus,
  additionalExtensionPaths: [
    ...(useRuntime ? [] : [extensionPath]),
    join(import.meta.dirname, "bridge-extension.ts"),
  ],
  ...(useRuntime
    ? {
        extensionFactories: [
          ...createOrbExtensions({ cwd: root, subagents: runtime, mcp }),
          {
            name: "root-only-contract",
            factory: (pi) => {
              pi.on("session_start", () => {
                rootExtensionStarts++;
              });
            },
          },
        ],
      }
    : {}),
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
});
await checked(loader.reload());
assert.deepEqual(loader.getExtensions().errors, []);
manager = SessionManager.create(root, join(root, "sessions"));
({ session } = await checked(
  createAgentSession({
    cwd: root,
    agentDir,
    modelRuntime,
    model,
    settingsManager,
    sessionManager: manager,
    resourceLoader: loader,
    tools: ["launch_children", "subagent", ...(toolModelScenario ? ["get_subagent_result"] : [])],
    customTools: [
      {
        name: "launch_children",
        label: "Launch controlled children",
        description: "Test fixture",
        parameters: { type: "object", properties: {} },
        async execute() {
          const labels =
            scenario === "queued" || scenario === "cancel-queued" || scenario === "model-selection"
              ? ["one", "two"]
              : ["one"];
          for (const label of labels) {
            const id = service.spawn("probe", `CHILD_${label}`, {
              description: label,
              ...(scenario === "model-selection"
                ? { model: label === "one" ? "SoL" : "OPENAI-CODEX/GPT-6-SOL" }
                : scenario === "model-unavailable"
                  ? { model: "openai-codex/gpt-6-sol" }
                  : lockedModelScenario || scenario === "model-inherit"
                    ? { model: "sol-new" }
                    : {}),
            });
            ids.set(label, id);
          }
          if (scenario === "model-selection" || scenario === "model-unavailable") {
            if (scenario === "model-unavailable")
              assert.throws(
                () => service.spawn("probe", "INVALID_CHILD", { model: "SoL" }),
                /Model unavailable/,
              );
            for (const selector of ["", "sol-new", "openai-codex/gpt-6.2-sol", "gpt-6-sol"])
              assert.throws(
                () => service.spawn("probe", "INVALID_CHILD", { model: selector }),
                /Model not found/,
              );
          }
          if (scenario === "model-unavailable") assert.equal(service.listAgents().length, 1);
          note("children:admitted", {
            statuses: service.listAgents().map((record) => record.status),
          });
          return { content: text("Children admitted"), details: {} };
        },
      },
    ],
  }),
));
await checked(
  session.bindExtensions({
    onError: (error) => note("extension:error", { message: String(error) }),
  }),
);
if (runtime)
  runtime.attachSession(session, manager, {
    summarize: (input) => {
      summaryInputs.push(input.transcript);
      note("summary:called");
      return ResultAsync.fromSafePromise(Promise.resolve("completed"));
    },
  });
service = globalThis[Symbol.for("pi-orb:liveness-fixture")].getService();
assert.ok(service);
assert.equal(service.hasRunning(), false);
if (loadFailure) {
  // A discovered extension pre-registers a name that native MCP otherwise
  // registers only at session_start. Reject before binding or child inference.
  writeFileSync(
    join(agentDir, "extensions", "mcp-collision.ts"),
    `export default pi => pi.registerTool({ name: "mcp__approved__probe", label: "collision", description: "collision", parameters: { type: "object", properties: {} }, async execute() { return { content: [{ type: "text", text: "COLLIDING_TOOL_EXECUTED" }], details: {} }; } });`,
  );
}
if (scenario === "spawn-failure" || cancelStarting || credentialScenario || loadFailure) {
  service.registerWorkspaceProvider({
    async prepare() {
      note("workspace:prepare-entered");
      await failureGate.promise;
      if (scenario === "spawn-failure") {
        // WorkspaceProvider's framework contract reports preparation failure by rejection.
        return Promise.reject(new Error("injected workspace preparation failure"));
      }
      return { cwd: root, dispose: () => undefined };
    },
  });
}

session.subscribe((event) => {
  if (event.type === "agent_start") {
    claimedParent = false;
    parentStarts++;
    checkBridge();
    note("parent:start", { parentStarts });
  } else if (event.type === "agent_settled") {
    const settled = ++parentSettles;
    queueMicrotask(() => {
      checkBridge();
      note("parent:settled", { parentSettles: settled, parentIdle: session.isIdle, bridgeBusy });
    });
  }
});

// All waits are explicit model/tool/event checkpoints. The outer process test
// timeout is only a deadlock watchdog; it does not decide event ordering.
claimedParent = true;
checkBridge();
const prompt = runtime
  ? (async () => {
      const result = await runtime.submitMessage(
        [{ type: "text", text: "ROOT" }],
        "fixture-operation",
      );
      assert.equal(result.isOk(), true);
    })()
  : checked(session.prompt("ROOT"));
await waitEvent("children:admitted");
await waitEvent("model:parent-final-entered");
if (useRuntime)
  assert.equal(
    manager
      .getEntries()
      .some(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === "pi-orb.subagent-run" &&
          entry.data.phase === "started" &&
          entry.data.childId === ids.get("one"),
      ),
    true,
  );
if (mcpScenario && !loadFailure && !cancelStarting) {
  await until(() => saw("tool:one:entered") || terminalRows.length > 0);
  assert.equal(saw("tool:one:entered"), true, service.getRecord(ids.get("one"))?.error);
}
await waitEvent(
  scenario === "spawn-failure" || cancelStarting || credentialScenario || loadFailure
    ? "workspace:prepare-entered"
    : "tool:one:entered",
);
assert.equal(service.hasRunning(), true);
assert.equal(bridgeBusy, true);

if (scenario === "child-first") {
  childGates.get("one").resolve();
  await waitEvent("child:terminal-drained");
  assert.equal(service.hasRunning(), false);
  assert.equal(session.isIdle, false);
  assert.equal(saw("model:followup-entered"), false);
  assert.equal(bridgeBusy, true);
  parentGate.resolve();
} else {
  parentGate.resolve();
  await until(() => parentSettles === 1);
  assert.equal(session.isIdle, true);
  assert.equal(bridgeBusy, true);
  assert.equal(service.hasRunning(), true);
  if (runtime) assertSubagentActivity(runtime, "busy", "fixture-operation");
  note("assert:parent-idle-orb-busy");
  if (scenario === "inbox-child-only") {
    const content = [{ type: "text", text: "USER_DURING_CHILD" }];
    // The SDK submission promise may include the root completion/wake chain.
    // Observe acceptance separately; never await it while holding its tool gate.
    inboxDelivery = runtime.deliverInboxMessage("fixture-inbox", ["fixture-inbox"], content);
    await waitEvent("model:inbox-entered");
    const duplicate = (
      await runtime.deliverInboxMessage("fixture-inbox", ["fixture-inbox"], content)
    )._unsafeUnwrap();
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.delivery, "turn");
    assert.equal(duplicate.operationId, "fixture-operation");
    assert.equal(parentStarts, 2);
    assertSubagentActivity(runtime, "busy", "fixture-operation");
    note("assert:child-only-inbox-is-one-deduplicated-root-turn");
  }
  if (shutdownScenario) {
    assert.ok(runtime);
    let returnedBeforeCleanup = false;
    shuttingDown = checked(
      session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
    ).then(() => {
      returnedBeforeCleanup = !saw("tool:one:exited");
      note("shutdown:returned");
    });
    await waitEvent("tool:one:abort-observed");
    // An in-process tool must finish cleanup before shutdown. Native HTTP
    // abort instead terminates the client request while the remote server may
    // retain its already-accepted work; closing the child cannot close root.
    await new Promise((resolve) => setImmediate(resolve));
    if (!mcpScenario)
      assert.equal(returnedBeforeCleanup, false, "shutdown returned before child tool cleanup");
    if (mcpScenario) {
      assert.equal(mcpFixture.calls.filter((call) => call.method === "tools/call").length, 1);
      assert.equal(
        mcpFixture.calls.some((call) => call.method === "DELETE" && call.session === "native-1"),
        false,
      );
      assert.equal(runtime.mayWakeSubagent(ids.get("one")), false);
    }
    assert.equal(runtime.getHealth().activity, mcpScenario ? "idle" : "busy");
  }
  if (scenario === "cancel-running") {
    if (runtime) assert.equal((await runtime.abortOperation()).isOk(), true);
    else assert.equal(service.abort(ids.get("one")), true);
    await waitEvent("tool:one:abort-observed");
    assert.equal(service.getRecord(ids.get("one")).status, "stopped");
    assert.equal(service.hasRunning(), false);
    await checked(service.waitForAll());
    assert.equal(saw("tool:one:exited"), false);
    assert.equal(terminalRows.length, 0);
    assert.equal(bridgeBusy, true);
    note("assert:snapshot-and-wait-finish-before-cancellation-drains");
  }
  if (cancelStarting) {
    if (runtime) assert.equal((await runtime.abortOperation()).isOk(), true);
    else assert.equal(service.abort(ids.get("one")), true);
    assert.equal(service.hasRunning(), false);
    await checked(service.waitForAll());
    assert.equal(bridgeBusy, true);
    assert.equal(saw("tool:one:entered"), false);
    failureGate.resolve();
    // Characterize the source-audited missing already-aborted check: the
    // session binds its abort listener after preparation, so the child runs.
    if (runtime) {
      await waitEvent("child:terminal-drained");
      assert.equal(saw("model:child:one"), false);
      assert.equal(saw("tool:one:entered"), false);
      note("assert:cancelled-startup-executes-zero-work");
    } else {
      await waitEvent("tool:one:entered");
      assert.equal(saw("tool:one:abort-observed"), false);
      assert.equal(service.getRecord(ids.get("one")).status, "stopped");
      assert.equal(service.hasRunning(), false);
      assert.equal(bridgeBusy, true);
      note("assert:cancel-during-startup-still-executes-child");
    }
  }
  if (scenario === "cancel-queued") {
    assert.equal(service.getRecord(ids.get("two")).status, "queued");
    assert.equal(service.abort(ids.get("two")), true);
    assert.equal(saw("tool:two:entered"), false);
    assert.equal(bridgeBusy, true);
    note("assert:queued-cancel-did-not-start-child");
  }
  if (credentialScenario) {
    // Expire the shared broker-only store at a controlled startup boundary,
    // after root inference and before the child constructs its own runtime.
    const path = join(agentDir, "auth.json");
    const auth = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(auth["liveness-probe"].refresh, "pi-orb-broker");
    auth["liveness-probe"].expires = 0;
    writeFileSync(path, JSON.stringify(auth));
    failureGate.resolve();
  }
  if (loadFailure) childGates.get("one").resolve();
  if (scenario === "spawn-failure" || loadFailure) failureGate.resolve();
  else childGates.get("one").resolve();
}

if (scenario === "queued" || scenario === "model-selection") {
  await waitEvent("tool:two:entered");
  assert.equal(service.hasRunning(), true);
  assert.equal(bridgeBusy, true);
  childGates.get("two").resolve();
}
if (scenario === "model-unavailable") {
  assert.equal(
    trace
      .filter((row) => row.event.startsWith("model:child:"))
      .every((row) => row.model === "gpt-6-sol"),
    true,
  );
}
if (modelPolicyScenario) {
  await until(() => terminalRows.length === 1);
  const receipt = manager
    .getEntries()
    .find((entry) => entry.type === "custom" && entry.customType === "subagents:record");
  assert.equal(receipt.data.requestedModel, scenario === "model-inherit" ? undefined : "SoL");
  assert.deepEqual(receipt.data.resolvedModel, expectedPolicyModel);
  assert.ok(trace.some((row) => row.event === "model:child:one"));
}
if (scenario === "model-selection") {
  await until(() => terminalRows.length === 2);
  const records = manager
    .getEntries()
    .filter((entry) => entry.type === "custom" && entry.customType === "subagents:record");
  assert.deepEqual(
    records.map((entry) => [entry.data.requestedModel, entry.data.resolvedModel]),
    [
      ["SoL", { provider: "openai-codex", id: "gpt-6.1-sol" }],
      ["OPENAI-CODEX/GPT-6-SOL", { provider: "openai-codex", id: "gpt-6-sol" }],
    ],
  );
}
const wholeAbort = runtime && (scenario === "cancel-running" || cancelStarting || shutdownScenario);
if (scenario === "inbox-child-only") {
  await until(() => terminalRows.length === ids.size);
  assert.equal(terminalRows[0].parentIdle, false);
  assert.equal(saw("model:followup-entered"), false);
  inboxGate.resolve();
}
if (!wholeAbort) await waitEvent("model:followup-entered");
await until(() => terminalRows.length === ids.size);
// The real extension wakes the parent even for explicit cancellation.
if (scenario === "cancel-running") note("assert:cancel-completion-wakes-parent");
if (!wholeAbort) assert.equal(bridgeBusy, true);
if (loadFailure) {
  assert.equal(service.getRecord(ids.get("one")).status, "error");
  assert.match(service.getRecord(ids.get("one")).error, /mcp__approved__probe|conflict/i);
  assert.equal(saw("model:child:one"), false);
  assert.equal(saw("tool:one:entered"), false);
  assert.equal(mcpFixture.calls.filter((call) => call.method === "initialize").length, 1);
  note("assert:child-resource-collision-fails-before-native-init-or-inference");
}
if (scenario === "spawn-failure") {
  assert.equal(service.getRecord(ids.get("one")).status, "error");
  assert.match(service.getRecord(ids.get("one")).error, /injected workspace/);
  assert.equal(saw("tool:one:entered"), false);
  note("assert:failed-spawn-is-terminal-and-visible");
}
assert.equal(
  terminalRows.every((row) => row.persisted === false),
  true,
);
if (scenario === "parent-first") {
  assert.equal(terminalRows[0].parentIdle, true);
  assert.equal(terminalRows[0].hasRunning, false);
  note("assert:naive-snapshot-would-publish-premature-idle");
}
followupGate.resolve();
await prompt;
await until(() => !bridgeBusy);
assert.equal(service.hasRunning(), false);
assert.equal(session.isIdle, true);
if (wholeAbort) {
  assert.equal(saw("model:followup-entered"), false);
  assert.equal(parentStarts, 1);
  note("assert:whole-operation-abort-does-not-wake-parent");
}
assert.deepEqual(activityEdges, ["busy", "idle"]);
assert.equal(
  trace.some((row) => row.event === "extension:error"),
  false,
);
assert.equal([...ids.values()].every(terminalRecordExists), true);
const reloaded = SessionManager.open(manager.getSessionFile());
assert.equal(
  reloaded
    .getEntries()
    .filter((entry) => entry.type === "custom" && entry.customType === "subagents:record").length,
  ids.size,
);
if (runtime) assertSubagentActivity(runtime, "idle", null);
if (inboxDelivery) {
  const delivered = (await inboxDelivery)._unsafeUnwrap();
  assert.equal(delivered.delivery, "turn");
  assert.equal(delivered.operationId, "fixture-operation");
  assert.equal(delivered.duplicate, false);
}
note("assert:one-continuous-busy-period", { activityEdges, parentStarts, parentSettles });
if (useRuntime) {
  if (wholeAbort) assert.equal(summaryInputs.length, 0);
  else {
    await waitEvent("summary:called");
    assert.equal(summaryInputs.length, 1);
    const status =
      scenario === "spawn-failure" || scenario === "credential-failure" || loadFailure
        ? "error"
        : "completed";
    assert.equal(
      summaryInputs[0].includes(`[subagent ${status}] one`),
      true,
      "summary omitted the persisted child outcome",
    );
    assert.equal(summaryInputs[0].includes("parent processed child outcome"), true);
    note("assert:one-summary-includes-aggregate-outcomes");
  }
  assert.equal(rootExtensionStarts, 1);
  note("assert:root-inline-extension-not-inherited");
}
if (credentialScenario) {
  assert.ok(trace.some((row) => row.event === "broker:request" && row.reason === "expiring"));
  assert.equal(JSON.stringify(reloaded.getEntries()).includes("fake-access-"), false);
  if (scenario === "credential-failure") {
    assert.equal(saw("model:child:one"), false);
    assert.equal(saw("tool:one:entered"), false);
    assert.equal(service.getRecord(ids.get("one")).status, "error");
    note("assert:child-credential-failure-does-not-replay-work");
  } else {
    assert.equal(brokerGrants, 2);
    note("assert:child-refreshes-through-inherited-broker");
  }
}

if (scenario === "resume-cancel") {
  assert.ok(runtime);
  resumePhase = true;
  const followupsBefore = trace.filter((row) => row.event === "model:followup-entered").length;
  const resumed = runtime.submitMessage(
    [{ type: "text", text: "ROOT_RESUME" }],
    "resumed-operation",
  );
  await waitEvent("tool:two:entered");
  assert.equal(runtime.gateView().activeOperationId, "resumed-operation");
  assert.equal(runtime.getHealth().activity, "busy");
  assert.equal((await runtime.abortOperation()).isOk(), true);
  await waitEvent("tool:two:abort-observed");
  assert.equal(runtime.getHealth().activity, "busy");
  childGates.get("two").resolve();
  await until(() => terminalRows.length === 2 && !bridgeBusy);
  assert.equal((await resumed).isOk(), true);
  assert.equal(
    trace.filter((row) => row.event === "model:followup-entered").length,
    followupsBefore,
  );
  assert.deepEqual(activityEdges, ["busy", "idle", "busy", "idle"]);
  assert.equal(service.getRecord(ids.get("one")).status, "stopped");
  const records = SessionManager.open(manager.getSessionFile())
    .getEntries()
    .filter((entry) => entry.type === "custom" && entry.customType === "subagents:record");
  assert.equal(records.at(-1)?.data.requestedModel, undefined);
  assert.deepEqual(records.at(-1)?.data.resolvedModel, { provider: "liveness-probe", id: "probe" });
  assert.ok(
    trace.some(
      (row) =>
        row.event === "model:child:two" &&
        row.provider === "liveness-probe" &&
        row.model === "probe",
    ),
  );
  note("assert:explicit-resume-owns-fresh-cancellation-and-operation");
}

if (scenario === "idle-stop") {
  assert.equal(runtime.prepareIdleStop()._unsafeUnwrap(), true);
  assert.equal(runtime.admitSubagent("too-late").isErr(), true);
  assert.equal((await runtime.submitMessage([], "too-late")).isErr(), true);
  const before = trace.filter((row) => row.event.startsWith("model:")).length;
  // Even an extension bypassing the HTTP gate must not start inference once
  // the host has received permission to stop this idle runtime.
  await checked(session.sendUserMessage([{ type: "text", text: "LATE_EXTENSION_PROMPT" }]));
  assert.equal(trace.filter((row) => row.event.startsWith("model:")).length, before);
  note("assert:idle-stop-fences-sdk-root-and-child-admission");
}

// Invoke the public extension runner's shutdown lifecycle before dispose, as
// Pi's host does. This closes gotgenes's retention interval and child sessions.
if (mcpScenario && !shuttingDown)
  assert.equal(mcpFixture.calls.filter((call) => call.method === "DELETE").length, 0);
if (shuttingDown) {
  await shuttingDown;
  note("assert:shutdown-awaits-child-cleanup");
} else await checked(session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }));
if (mcpScenario) {
  const initializations = mcpFixture.calls.filter((call) => call.method === "initialize").length;
  const closures = mcpFixture.calls.filter((call) => call.method === "DELETE").length;
  assert.equal(initializations, loadFailure || cancelStarting ? 1 : 2);
  assert.equal(closures, initializations, "each native session closes its own MCP connection");
  if (cancelStarting)
    assert.equal(mcpFixture.calls.filter((call) => call.method === "tools/call").length, 0);
  if (scenario === "mcp-profile") {
    assert.equal(mcpFixture.calls.filter((call) => call.method === "tools/call").length, 0);
    assert.equal(saw("assert:child-codemode-denies-mcp-and-bash"), true);
  }
  if (initializations === 2) {
    const deleted = mcpFixture.calls
      .filter((call) => call.method === "DELETE")
      .map((call) => call.session);
    assert.deepEqual(
      deleted,
      ["native-2", "native-1"],
      "child closes before root, never closing root on child teardown",
    );
  }
  note("assert:root-and-child-own-native-connections", { initializations, closures });
}
session.dispose();
if (mcpFixture) await mcpFixture.close();
note("PASS", { scenario });

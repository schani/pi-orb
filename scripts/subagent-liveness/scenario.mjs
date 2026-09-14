import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
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
const credentialScenario = scenario === "credential-refresh" || scenario === "credential-failure";
let rootExtensionStarts = 0;
const summaryInputs = [];
let brokerGrants = 0;
let rejectChildRefresh = scenario === "credential-failure";
const { PiOrbAgent } = useRuntime ? await import("../../apps/orb-runtime/src/pi/agent.ts") : {};
const { createSubagentsExtension } = useRuntime
  ? await import("../../apps/orb-runtime/src/pi/extensions/subagents.ts")
  : {};
const root = process.env.FIXTURE_ROOT;
const agentDir = process.env.PI_CODING_AGENT_DIR;
mkdirSync(join(agentDir, "agents"), { recursive: true });
mkdirSync(join(agentDir, "extensions"), { recursive: true });
writeFileSync(
  join(agentDir, "extensions", "probe.ts"),
  readFileSync(join(import.meta.dirname, "probe-extension.ts")),
);
writeFileSync(
  join(agentDir, "agents", "probe.md"),
  "---\nname: probe\ndescription: Deterministic liveness child\ntools: probe_gate\n---\nExecute the test task.\n",
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
const parentGate = gate();
const followupGate = gate();
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
const waitEvent = (event) => until(() => saw(event));
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
      };
      terminalRows.push(row);
      note("child:terminal-callback", row);
      // Candidate bridge uses only public APIs. Retain the child's activity
      // until the synchronous terminal callback has finished persistence and
      // notification scheduling. This is a pinned ordering assumption to test,
      // not a proposed generic protocol or a timing grace period.
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
function scriptedStream(model, context, options) {
  const stream = createAssistantMessageEventStream();
  const allText = JSON.stringify(context.messages);
  const child =
    resumePhase && allText.includes("CONTINUE_CHILD")
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
      const names = context.tools.map((tool) => tool.name);
      assert.ok(names.includes("probe_gate"));
      for (const rootOnly of [
        "launch_children",
        "resume_child",
        "subagent",
        "get_subagent_result",
        "steer_subagent",
      ])
        assert.equal(names.includes(rootOnly), false);
      if (credentialScenario) assert.equal(options.apiKey === "fake-access-2", true);
      note(`model:child:${child}`);
      message =
        toolResults.length === 0 || (child === "two" && resumePhase && !resumeToolSent)
          ? output(model, call("probe_gate", { label: child }), "toolUse")
          : output(model, text(`child ${child} finished`), "stop");
      if (resumePhase) resumeToolSent = true;
    } else if (resumePhase) {
      message = output(model, call("resume_child", {}), "toolUse");
    } else if (allText.includes("task-notification")) {
      note("model:followup-entered");
      await followupGate.promise;
      message = output(model, text("parent processed child outcome"), "stop");
    } else if (toolResults.length === 0) {
      note("model:root-launch");
      message = output(model, call("launch_children", {}), "toolUse");
    } else {
      note("model:parent-final-entered");
      await parentGate.promise;
      message = output(model, text("parent finished its own turn"), "stop");
    }
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: message.stopReason, message });
    stream.end();
  };
  void ResultAsync.fromPromise(run(), (error) => ({ message: String(error) })).mapErr((error) => {
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
          { name: "pi-orb:subagents", factory: createSubagentsExtension(runtime) },
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
    tools: ["launch_children", "resume_child"],
    customTools: [
      {
        name: "resume_child",
        label: "Resume controlled child",
        description: "Test fixture",
        parameters: { type: "object", properties: {} },
        async execute() {
          await checked(service.resume(ids.get("one"), "CONTINUE_CHILD"));
          return { content: text("Resume returned"), details: {} };
        },
      },
      {
        name: "launch_children",
        label: "Launch controlled children",
        description: "Test fixture",
        parameters: { type: "object", properties: {} },
        async execute() {
          const labels =
            scenario === "queued" || scenario === "cancel-queued" ? ["one", "two"] : ["one"];
          for (const label of labels) {
            const id = service.spawn("probe", `CHILD_${label}`, { description: label });
            ids.set(label, id);
          }
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
if (scenario === "spawn-failure" || scenario === "cancel-starting" || credentialScenario) {
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
    parentSettles++;
    checkBridge();
    note("parent:settled", { parentSettles, parentIdle: session.isIdle, bridgeBusy });
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
await waitEvent(
  scenario === "spawn-failure" || scenario === "cancel-starting" || credentialScenario
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
  if (scenario === "shutdown-running") {
    assert.ok(runtime);
    let returnedBeforeCleanup = false;
    shuttingDown = checked(
      session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
    ).then(() => {
      returnedBeforeCleanup = !saw("tool:one:exited");
      note("shutdown:returned");
    });
    await waitEvent("tool:one:abort-observed");
    // The scripted provider and shutdown hooks perform only microtask work.
    // Yield one event-loop boundary while the explicit cleanup gate stays shut.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(returnedBeforeCleanup, false, "shutdown returned before child tool cleanup");
    assert.equal(runtime.getHealth().activity, "busy");
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
  if (scenario === "cancel-starting") {
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
  if (scenario === "spawn-failure") failureGate.resolve();
  else childGates.get("one").resolve();
}

if (scenario === "queued") {
  await waitEvent("tool:two:entered");
  assert.equal(service.hasRunning(), true);
  assert.equal(bridgeBusy, true);
  childGates.get("two").resolve();
}
const wholeAbort =
  runtime &&
  (scenario === "cancel-running" ||
    scenario === "cancel-starting" ||
    scenario === "shutdown-running");
if (!wholeAbort) await waitEvent("model:followup-entered");
await until(() => terminalRows.length === ids.size);
// The real extension wakes the parent even for explicit cancellation.
if (scenario === "cancel-running") note("assert:cancel-completion-wakes-parent");
if (!wholeAbort) assert.equal(bridgeBusy, true);
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
note("assert:one-continuous-busy-period", { activityEdges, parentStarts, parentSettles });
if (useRuntime) {
  if (wholeAbort) assert.equal(summaryInputs.length, 0);
  else {
    await waitEvent("summary:called");
    assert.equal(summaryInputs.length, 1);
    const status =
      scenario === "spawn-failure" || scenario === "credential-failure" ? "error" : "completed";
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
  note("assert:explicit-resume-owns-fresh-cancellation-and-operation");
}

// Invoke the public extension runner's shutdown lifecycle before dispose, as
// Pi's host does. This closes gotgenes's retention interval and child sessions.
if (shuttingDown) {
  await shuttingDown;
  note("assert:shutdown-awaits-child-cleanup");
} else await checked(session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }));
session.dispose();
note("PASS", { scenario });

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  createContextMeasurement,
  summarizeContext,
  summarizePayload,
} from "./context-measurement.mjs";

const secret = "fixture-private-grant-🗝";

test("measure full transcript and provider payload without retaining scalar content", () => {
  const context = summarizeContext([
    { role: "system", content: `instructions ${secret}` },
    { role: "user", content: [{ type: "text", text: "🔎" }] },
  ]);
  const payload = summarizePayload({
    messages: [{ content: secret }],
    tools: [{ name: "private_tool" }],
  });
  assert.equal(context.kind, "transcript");
  assert.equal(
    summarizeContext([{ role: "system", content: "🗝" }]).codepoints,
    [...JSON.stringify([{ role: "system", content: "🗝" }])].length,
  );
  assert.equal(context.messageCount, 2);
  assert.equal(
    context.utf8Bytes,
    Buffer.byteLength(
      JSON.stringify([
        { role: "system", content: `instructions ${secret}` },
        { role: "user", content: [{ type: "text", text: "🔎" }] },
      ]),
    ),
  );
  assert.equal(
    context.codepoints,
    [
      ...JSON.stringify([
        { role: "system", content: `instructions ${secret}` },
        { role: "user", content: [{ type: "text", text: "🔎" }] },
      ]),
    ].length,
  );
  assert.equal(payload.kind, "provider_payload");
  assert.equal(
    payload.utf8Bytes,
    Buffer.byteLength(
      JSON.stringify({ messages: [{ content: secret }], tools: [{ name: "private_tool" }] }),
    ),
  );
  for (const evidence of [context, payload]) {
    assert.equal(evidence.tokenizerEstimate, null);
    assert.equal(evidence.exactModelTokens, null);
    assert.equal(JSON.stringify(evidence).includes(secret), false);
    assert.equal(JSON.stringify(evidence).includes("private_tool"), false);
  }
});

test("unserializable inputs report unavailable without leaking contents", () => {
  const circular = { secret };
  circular.self = circular;
  for (const record of [
    summarizeContext([circular]),
    summarizePayload(circular),
    summarizePayload(undefined),
    summarizePayload(1n),
  ]) {
    assert.equal(record.status, "unavailable");
    assert.equal(record.utf8Bytes, null);
    assert.equal(record.codepoints, null);
    assert.equal(JSON.stringify(record).includes(secret), false);
  }
});

test("untrusted profile and phase labels cannot reach output", () => {
  const records = [];
  const listeners = {};
  const pi = {
    on: (name, handler) => {
      listeners[name] = handler;
    },
    getActiveTools: () => ["mcp__visible", "other"],
  };
  createContextMeasurement(
    secret,
    () => secret,
    (record) => records.push(record),
  )(pi);
  listeners.context_with_system({ messages: [] });
  listeners.before_provider_request({ payload: secret });
  assert.equal(records.length, 2);
  assert.equal(JSON.stringify(records).includes(secret), false);
  assert.equal(
    records.every((record) => record.profile === "invalid" && record.phase === "invalid"),
    true,
  );
  assert.equal(records[0].activeMcpToolCount, 1);
  assert.equal("approvedToolCount" in records[0], false);
  createContextMeasurement(
    "root",
    () => {
      throw new Error(secret);
    },
    (record) => records.push(record),
  )(pi);
  listeners.context_with_system({ messages: [] });
  assert.equal(records.at(-1).phase, "invalid");
  assert.equal(JSON.stringify(records).includes(secret), false);
  createContextMeasurement(
    "child",
    () => "after_search",
    (record) => records.push(record),
  )(pi);
  listeners.context_with_system({ messages: [] });
  assert.equal(records.at(-1).phase, "after_search");
  assert.equal(records.at(-1).profile, "child");
});

test("generic output receives exactly one sanitized argument, never SDK context", () => {
  const handlers = new Map();
  const secret = { privateSession: "must-not-pass" };
  const records = [];
  createContextMeasurement(
    "root",
    () => "before_discovery",
    (...args) => records.push(args),
  )({
    on: (name, callback) => handlers.set(name, callback),
    getActiveTools: () => [],
  });
  handlers.get("context_with_system")({ messages: [] }, secret);
  handlers.get("before_provider_request")({ payload: { messages: [] } }, secret);
  assert.equal(records.length, 2);
  assert.ok(records.every((args) => args.length === 1));
  assert.equal(JSON.stringify(records).includes("must-not-pass"), false);
});

test("pinned SDK fixture manually emits hooks for independent root/child active tool profiles, not a model pipeline", async () => {
  const stage = join(
    resolve(import.meta.dirname, "../../.."),
    ".context/dedicated-oauth-reauthorization/corrected-2/package-2/staging",
  );
  const sdkPath = join(stage, "node_modules/@earendil-works/pi-coding-agent");
  const sdk = await import(pathToFileURL(join(sdkPath, "dist/index.js")).href);
  assert.equal(JSON.parse(await readFile(join(sdkPath, "package.json"), "utf8")).version, "0.99.1");
  const dir = await mkdtemp(join(tmpdir(), "native-mcp-context-"));
  const results = [];
  const sessions = [];
  try {
    for (const [profile, names] of [
      ["root", ["mcp__cloudflare__execute", "mcp__datadog__search"]],
      ["child", ["mcp__cloudflare__execute"]],
    ]) {
      let phase = "before_discovery";
      const loader = new sdk.DefaultResourceLoader({
        cwd: dir,
        agentDir: dir,
        extensionFactories: [
          {
            name: "qualification:capture",
            factory: createContextMeasurement(
              profile,
              () => phase,
              (record) => results.push(record),
            ),
          },
          {
            name: "qualification:tools",
            factory: (pi) => {
              for (const name of names)
                pi.registerTool({
                  name,
                  label: name,
                  description: `approved ${secret}`,
                  parameters: { type: "object", properties: {} },
                  execute: async () => ({ content: [], details: undefined }),
                });
            },
          },
        ],
      });
      await loader.reload();
      const modelRuntime = await sdk.ModelRuntime.create({
        authPath: join(dir, "auth.json"),
        allowModelNetwork: false,
      });
      const { session } = await sdk.createAgentSession({
        cwd: dir,
        agentDir: dir,
        resourceLoader: loader,
        modelRuntime,
        sessionManager: sdk.SessionManager.inMemory(),
        settingsManager: sdk.SettingsManager.inMemory(),
      });
      sessions.push(session);
      await session.bindExtensions({});
      // Pi's public runner fires this hook on a real model turn. No model turn is started here:
      // this fixture checks capture wiring, not a provider request or authenticated discovery.
      session.setActiveToolsByName([]);
      await session.extensionRunner.emitContext([
        { role: "system", content: `${session.systemPrompt} ${secret}`, timestamp: 0 },
        { role: "user", content: [{ type: "text", text: "find" }], timestamp: 0 },
      ]);
      assert.equal(results.at(-1).activeMcpToolCount, 0);
      phase = "after_discovery";
      session.setActiveToolsByName(names);
      const activeNames = session.getActiveToolNames().filter((name) => name.startsWith("mcp__"));
      assert.deepEqual(activeNames.sort(), [...names].sort());
      await session.extensionRunner.emitContext([
        { role: "system", content: `${session.systemPrompt} ${secret}`, timestamp: 0 },
        { role: "user", content: [{ type: "text", text: "find" }], timestamp: 0 },
      ]);
      assert.equal(results.at(-1).activeMcpToolCount, names.length);
      assert.equal(results.at(-1).profile, profile);
      assert.equal(results.at(-1).messageCount, 2);
      assert.equal(results.at(-1).phase, phase);
      const request = { messages: [{ content: secret }], tools: names.map((name) => ({ name })) };
      assert.equal(await session.extensionRunner.emitBeforeProviderRequest(request), request);
      assert.equal(results.at(-1).kind, "provider_payload");
      assert.equal(results.at(-1).utf8Bytes, Buffer.byteLength(JSON.stringify(request)));
    }
    assert.equal(results.length, 6);
    assert.equal(JSON.stringify(results).includes(secret), false);
    assert.equal(JSON.stringify(results).includes("mcp__"), false);
  } finally {
    for (const session of sessions) session.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

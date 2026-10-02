import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createAgentSession,
  createMcpExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { McpClient, McpHttpError } from "@earendil-works/pi-mcp";
import { err, ok } from "neverthrow";
import {
  brokerError,
  createBrokerTransport,
  piOwnedTransport,
  resolveBrokerCredential,
} from "./broker-transport.mjs";
import { startFixture } from "./transport-fixture.mjs";

async function connected(t, options = {}) {
  const fixture = await startFixture();
  let token = "first";
  const broker = {
    resolve: async () => ok({ accessToken: token, generation: token === "first" ? 1 : 2 }),
    rejected: () => {
      token = "second";
    },
  };
  const transport = createBrokerTransport({
    url: fixture.url,
    headers: { "x-static": "approved" },
    broker,
    ...options,
  });
  const client = new McpClient({ name: "isolated-proof", version: "1" });
  t.after(async () => {
    await client.close();
    await fixture.close();
  });
  await client.connect(transport);
  return {
    fixture,
    client,
    transport,
    setToken: (value) => {
      token = value;
    },
  };
}

test("broker credentials and approved static headers resolve on each POST and stream GET", async (t) => {
  const { fixture, client, setToken } = await connected(t);
  await client.callTool("write");
  setToken("rotated");
  await client.callTool("write");
  assert.deepEqual(
    fixture.calls.filter((c) => c.method === "tools/call").map((c) => c.token),
    ["first", "rotated"],
  );
  assert.equal(fixture.calls.filter((c) => c.method === "tools/call").length, fixture.accepted);
  assert.ok(fixture.calls.every((c) => c.static === "approved"));
  assert.ok(fixture.calls.some((c) => c.method === "GET" && c.token === "first"));
});

test("low-level native resource pagination, templates and read use broker credentials", async (t) => {
  const { fixture, client, setToken } = await connected(t);
  assert.deepEqual(
    (await client.listResources()).map((item) => item.uri),
    ["proof://one", "proof://two"],
  );
  setToken("rotated");
  assert.deepEqual(
    (await client.listResourceTemplates()).map((item) => item.uriTemplate),
    ["proof://{id}"],
  );
  assert.equal((await client.readResource("proof://one")).contents[0].text, "resource");
  assert.deepEqual(
    fixture.calls.filter((c) => c.method?.startsWith("resources/")).map((c) => c.token),
    ["first", "first", "rotated", "rotated"],
  );
});

test("response loss after accepting tool is not retried", async (t) => {
  const { fixture, client } = await connected(t);
  fixture.responseLoss = true;
  await assert.rejects(client.callTool("write"));
  assert.equal(fixture.accepted, 1);
  assert.equal(fixture.calls.filter((c) => c.method === "tools/call").length, 1);
});

test("401 with broker-only transport rejects; next explicit request uses replacement token", async (t) => {
  const { fixture, client } = await connected(t);
  fixture.rejectOnce = 401;
  await assert.rejects(client.callTool("write"));
  assert.equal(fixture.accepted, 0);
  assert.equal(fixture.calls.filter((c) => c.method === "tools/call").length, 1);
  await client.callTool("write");
  assert.deepEqual(
    fixture.calls.filter((c) => c.method === "tools/call").map((c) => c.token),
    ["first", "second"],
  );
  assert.equal(fixture.accepted, 1);
});

test("raw HTTP body cannot reach caller and redirects cannot carry bearer token", async (t) => {
  const { fixture, client } = await connected(t);
  fixture.rejectOnce = 500;
  await assert.rejects(client.callTool("write"), (e) => {
    assert.ok(e instanceof McpHttpError);
    assert.equal(e.status, 500);
    assert.doesNotMatch(String(e) + e.body, /SECRET_BODY/);
    return true;
  });
  fixture.redirect = true;
  await assert.rejects(client.callTool("write"), (e) => {
    assert.doesNotMatch(String(e), /SECRET_BODY|first/);
    return true;
  });
  assert.equal(fixture.redirectHits, 0);
});

async function sdkConnection(t, Transport) {
  const fixture = await startFixture();
  const cwd = await mkdtemp(join(tmpdir(), "native-mcp-proof-"));
  const used = { config: 0, transport: 0, authProviderPassed: false };
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    extensionFactories: [
      createMcpExtension({
        loadConfig: () => {
          used.config++;
          return {
            errors: [],
            servers: [
              {
                name: "proof",
                source: "authorized-boot",
                scope: "global",
                config: { url: fixture.url, exposure: "direct" },
              },
            ],
          };
        },
        createTransport: (entry, _cwd, authProvider) => {
          used.transport++;
          used.authProviderPassed = !!authProvider;
          return createBrokerTransport({
            url: entry.config.url,
            Transport,
            broker: { resolve: async () => ok({ accessToken: "boot", generation: 1 }) },
          });
        },
      }),
    ],
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(cwd, "auth.json"),
    allowModelNetwork: false,
  });
  const { session } = await createAgentSession({
    cwd,
    agentDir: cwd,
    modelRuntime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory(),
  });
  t.after(async () => {
    try {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      assert.ok(
        fixture.calls.some((call) => call.method === "DELETE"),
        "native connection closed by session_shutdown",
      );
    } finally {
      session.dispose();
      await fixture.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
  await session.bindExtensions({});
  await fixture.waitFor("tools/list");
  // Startup runs asynchronously: wait for the fixture's real tools/list reply, not a timer.
  // The extension transport callback proves use of the injected snapshot and factory.
  assert.equal(used.config, 1);
  assert.equal(used.transport, 1);
  assert.equal(
    fixture.calls.some((c) => c.method === "tools/list" && c.token === "boot"),
    true,
  );
  assert.equal(used.authProviderPassed, true); // Native builds a provider, but our transport does not install it.
  const readinessDeadline = AbortSignal.timeout(2000);
  while (!session.extensionRunner.getToolDefinition("mcp__proof__write")) {
    assert.equal(readinessDeadline.aborted, false, "native tool registration deadline");
    await new Promise((resolve) => setImmediate(resolve));
  }
  const tool = session.extensionRunner.getToolDefinition("mcp__proof__write");
  assert.ok(tool);
  return { fixture, tool };
}

test("SDK default pi-mcp identity reinitializes once after 404", {
  timeout: 5000,
}, async (t) => {
  const { fixture, tool } = await sdkConnection(t);
  fixture.invalidSessionOnce = true;
  const result = await tool.execute("call-id", {}, new AbortController().signal);
  assert.equal(result.isError, undefined);
  assert.equal(fixture.calls.filter((c) => c.method === "tools/call").length, 2);
  assert.equal(fixture.calls.filter((c) => c.method === "initialize").length, 2);
  assert.equal(fixture.accepted, 1);
});

test("SDK-owned public pi-mcp module identity retries invalid-session 404 once", {
  timeout: 5000,
}, async (t) => {
  const Transport = await piOwnedTransport();
  const { fixture, tool } = await sdkConnection(t, Transport);
  fixture.invalidSessionOnce = true;
  const result = await tool.execute("call-id", {}, new AbortController().signal);
  assert.equal(result.isError, undefined);
  assert.equal(fixture.calls.filter((c) => c.method === "tools/call").length, 2);
  assert.equal(fixture.accepted, 1);
  assert.equal(fixture.calls.filter((c) => c.method === "initialize").length, 2);
});

test("SDK extension does not replay an accepted tool after ambiguous response loss", {
  timeout: 5000,
}, async (t) => {
  const { fixture, tool } = await sdkConnection(t, await piOwnedTransport());
  fixture.responseLoss = true;
  await assert.rejects(tool.execute("call-id", {}, new AbortController().signal));
  assert.equal(fixture.calls.filter((c) => c.method === "tools/call").length, 1);
  assert.equal(fixture.accepted, 1);
  assert.equal(fixture.calls.filter((c) => c.method === "initialize").length, 1);
});

test("broker typed failures and unexpected throws stay redacted Results", async () => {
  for (const broker of [
    { resolve: async () => err({ code: "unavailable", message: "SECRET_BROKER" }) },
    {
      resolve: async () => {
        throw new Error("SECRET_BROKER");
      },
    },
  ]) {
    const result = await resolveBrokerCredential(broker);
    assert.equal(result.isErr(), true);
    assert.deepEqual(result.error, brokerError("unavailable"));
    assert.doesNotMatch(JSON.stringify(result.error), /SECRET_BROKER/);
  }
});

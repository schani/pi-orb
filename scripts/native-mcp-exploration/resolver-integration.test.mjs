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
import { ok } from "neverthrow";
import { McpCredentialResolver } from "../../apps/orb-runtime/src/mcp/oauth.ts";
import { createBrokerTransport, piOwnedTransport } from "./broker-transport.mjs";
import { startFixture } from "./transport-fixture.mjs";

test("actual runtime resolver drives native SDK transport across cache, expiry, 401 and accepted recovery", {
  timeout: 5000,
}, async (t) => {
  const fixture = await startFixture();
  const cwd = await mkdtemp(join(tmpdir(), "resolver-proof-"));
  let now = 1_000_000;
  const checkpoints = [];
  const task = {
    wallNow: () => now,
    checkpoint: async (name) => {
      checkpoints.push(name);
    },
  };
  const requests = [];
  let generation = 0;
  const endpoint = {
    request: async (_task, signal, rejectedGeneration) => {
      assert.equal(signal.aborted, false);
      requests.push(rejectedGeneration);
      generation++;
      return ok({ accessToken: `token-${generation}`, generation, expiresAt: now + 60_000 });
    },
  };
  const resolver = new McpCredentialResolver(endpoint);
  const Transport = await piOwnedTransport();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    extensionFactories: [
      createMcpExtension({
        loadConfig: () => ({
          errors: [],
          servers: [
            { name: "proof", source: "boot", config: { url: fixture.url, exposure: "direct" } },
          ],
        }),
        createTransport: (entry) =>
          createBrokerTransport({
            url: entry.config.url,
            Transport,
            broker: {
              resolve: (signal) => resolver.resolve(task, signal),
              rejected: (generation) => resolver.rejected(generation),
              accepted: () => resolver.accepted(),
            },
          }),
      }),
    ],
  });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(cwd, "auth.json"),
    allowModelNetwork: false,
  });
  const { session } = await createAgentSession({
    cwd,
    agentDir: cwd,
    resourceLoader: loader,
    modelRuntime,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory(),
  });
  t.after(async () => {
    try {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      session.dispose();
      await fixture.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
  await session.bindExtensions({});
  await fixture.waitFor("tools/list");
  const deadline = AbortSignal.timeout(2000);
  while (!session.extensionRunner.getToolDefinition("mcp__proof__write")) {
    assert.equal(deadline.aborted, false, "native tool registration deadline");
    await new Promise((resolve) => setImmediate(resolve));
  }
  const tool = session.extensionRunner.getToolDefinition("mcp__proof__write");
  const call = () => tool.execute("call-id", {}, new AbortController().signal);
  await call();
  await call();
  assert.deepEqual(requests, [undefined]); // startup and same-connection calls reuse generation 1
  now += 31_000;
  await call(); // expires within resolver's 30-second early-refresh window
  assert.deepEqual(requests, [undefined, undefined]);
  fixture.rejectOnce = 401;
  await assert.rejects(call());
  await call(); // explicit call gets next broker generation, never replays the rejected POST
  fixture.rejectOnce = 401;
  await assert.rejects(call());
  await call(); // accepted() cleared recovery state, permitting a new rejected generation
  assert.deepEqual(requests, [undefined, undefined, 2, 3]);
  assert.deepEqual(
    fixture.calls.filter((c) => c.method === "tools/call").map((c) => c.token),
    ["token-1", "token-1", "token-2", "token-2", "token-3", "token-3", "token-4"],
  );
  assert.equal(fixture.accepted, 5);
  assert.ok(checkpoints.every((name) => name === "mcp:credential-resolution"));
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { startNativeMcpFixture } from "./native-mcp-fixture.mjs";

// The actual SDK tool pipeline, not the model-facing tool list, must deny
// nested access to tools omitted by an agent's explicit tool profile.
for (const exposure of ["direct", "codemode", "deferred"])
  test(`codemode denies excluded child tools with ${exposure} exposure`, {
    timeout: 20_000,
  }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-child-codemode-profile-"));
    const gate = Promise.withResolvers();
    gate.resolve();
    const fixture = await startNativeMcpFixture({ gate, note: () => undefined });
    let session;
    try {
      const faux = fauxProvider({ provider: "restricted-child" });
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("codemode", {
            code: `let denied = 0;
for (const [name, args] of [["bash", {command:"echo FORBIDDEN"}], ["mcp__approved__probe", {}]]) {
  try { await tools[name](args); } catch (error) { denied++; text(name + ":" + String(error)); }
}
text("denied:" + denied + ";js:" + (6 * 7));`,
          }),
        ),
        fauxAssistantMessage("done"),
      ]);
      const modelRuntime = await ModelRuntime.create({
        authPath: join(cwd, "auth.json"),
        allowModelNetwork: false,
      });
      modelRuntime.registerNativeProvider(faux.provider);
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir: cwd,
        extensionFactories: [
          {
            name: "pi-orb:mcp",
            factory: createMcpExtension({
              loadConfig: () => ({
                errors: [],
                servers: [
                  {
                    name: "approved",
                    scope: "global",
                    source: "approved-boot",
                    config: { url: fixture.url, exposure },
                  },
                ],
              }),
            }),
          },
          { name: "pi-orb:codemode", factory: createCodemodeExtension({ mode: "on" }) },
        ],
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      const manager = SessionManager.inMemory();
      ({ session } = await createAgentSession({
        cwd,
        agentDir: cwd,
        modelRuntime,
        model: faux.getModel(),
        resourceLoader: loader,
        settingsManager: SettingsManager.inMemory({ defaultTools: ["codemode"] }),
        sessionManager: manager,
        tools: ["codemode"],
      }));
      await session.bindExtensions({});
      assert.deepEqual(
        session.getActiveToolNames(),
        ["codemode"],
        JSON.stringify(session.getAllTools().map(({ name, exposure }) => ({ name, exposure }))),
      );
      await session.prompt("Execute permitted JavaScript, attempt forbidden tools");
      const result = manager
        .getEntries()
        .find(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "toolResult" &&
            entry.message.toolName === "codemode",
        );
      assert.ok(result);
      assert.equal(result.message.isError, false);
      assert.match(JSON.stringify(result.message.content), /denied:2;js:42/);
      assert.equal(
        fixture.calls.filter(({ method }) => method === "tools/call").length,
        0,
        JSON.stringify(result.message.content),
      );
      assert.deepEqual(
        session.getAllTools().map(({ name }) => name),
        ["codemode"],
      );
      assert.equal(session.getCallableToolNames().includes("mcp__approved__probe"), false);
      assert.equal(faux.state.callCount, 2);
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      assert.equal(fixture.calls.filter(({ method }) => method === "DELETE").length, 1);
    } finally {
      session?.dispose();
      await fixture.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

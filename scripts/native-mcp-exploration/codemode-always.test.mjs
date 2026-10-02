import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

for (const kind of ["root", "child-style"]) {
  test(`native codemode executes without MCP in a ${kind} session`, {
    timeout: 15000,
  }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), `pi-codemode-${kind}-`));
    let session;
    try {
      const agentDir = join(cwd, "agent");
      const faux = fauxProvider({ provider: `codemode-${kind}` });
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("codemode", { code: 'text("pure-js:" + (6 * 7))' })),
        fauxAssistantMessage("done"),
      ]);
      const modelRuntime = await ModelRuntime.create({
        authPath: join(cwd, "auth.json"),
        allowModelNetwork: false,
      });
      modelRuntime.registerNativeProvider(faux.provider);
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        extensionFactories: [
          { name: "codemode", factory: createCodemodeExtension({ mode: "on" }) },
        ],
      });
      await resourceLoader.reload();
      const sessionManager = SessionManager.inMemory();
      ({ session } = await createAgentSession({
        cwd,
        agentDir,
        modelRuntime,
        model: faux.getModel(),
        resourceLoader,
        settingsManager: SettingsManager.inMemory({ defaultTools: ["codemode"] }),
        sessionManager,
      }));
      await session.bindExtensions({});
      await session.prompt("Run the pure JavaScript calculation");
      const results = sessionManager
        .getEntries()
        .filter(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "toolResult" &&
            entry.message.toolName === "codemode",
        );
      assert.equal(results.length, 1);
      assert.equal(results[0].message.isError, false);
      assert.match(JSON.stringify(results[0].message.content), /pure-js:42/);
      assert.equal(faux.state.callCount, 2);
    } finally {
      session?.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

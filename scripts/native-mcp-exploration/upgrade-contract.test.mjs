import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

test("released Pi 1.0.0 skips before_agent_start for idle triggered custom messages", {
  timeout: 10000,
}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-custom-preflight-"));
  const agentDir = join(cwd, "agent");
  let session;
  try {
    const faux = fauxProvider({ provider: "preflight-probe" });
    faux.setResponses([fauxAssistantMessage("ordinary"), fauxAssistantMessage("custom")]);
    const modelRuntime = await ModelRuntime.create({
      authPath: join(cwd, "auth.json"),
      allowModelNetwork: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    const observed = [];
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      extensionFactories: [
        (pi) =>
          pi.on("before_agent_start", (event) => {
            observed.push(event.prompt);
          }),
      ],
    });
    await resourceLoader.reload();
    ({ session } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      model: faux.getModel(),
      resourceLoader,
      settingsManager: SettingsManager.inMemory(),
      sessionManager: SessionManager.inMemory(),
    }));
    await session.bindExtensions({});
    let settled = 0;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "agent_settled") settled++;
    });
    try {
      await session.prompt("ordinary prompt");
      assert.deepEqual(observed, ["ordinary prompt"], "ordinary prompt runs preflight");
      assert.equal(session.isIdle, true);
      await session.sendCustomMessage(
        { customType: "preflight-probe", content: "custom trigger", display: true },
        { triggerTurn: true },
      );
      assert.deepEqual(
        observed,
        ["ordinary prompt"],
        "idle triggered custom turn bypasses preflight in released Pi 1.0.0",
      );
      assert.equal(session.isIdle, true);
      assert.equal(settled, 2, "both prompts completed an agent turn");
    } finally {
      unsubscribe();
    }
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

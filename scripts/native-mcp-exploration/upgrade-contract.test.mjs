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

test("prepares user and idle custom runs with their native trigger types", {
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
            observed.push(
              event.messageType === "custom"
                ? { messageType: event.messageType, message: event.message }
                : { messageType: event.messageType, prompt: event.prompt },
            );
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
      assert.deepEqual(observed, [{ messageType: "user", prompt: "ordinary prompt" }]);
      assert.equal(session.isIdle, true);
      await session.sendCustomMessage(
        { customType: "preflight-probe", content: "custom trigger", display: true },
        { triggerTurn: true },
      );
      assert.deepEqual(observed, [
        { messageType: "user", prompt: "ordinary prompt" },
        {
          messageType: "custom",
          message: {
            role: "custom",
            customType: "preflight-probe",
            content: "custom trigger",
            display: true,
            details: undefined,
            timestamp: observed[1]?.message?.timestamp,
          },
        },
      ]);
      assert.equal(typeof observed[1]?.message?.timestamp, "number");
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

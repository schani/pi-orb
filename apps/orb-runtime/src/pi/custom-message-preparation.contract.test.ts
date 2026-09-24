import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";

const OLD_PROMPT = "OLD_CUSTOM_TURN_PROMPT_SENTINEL";
const CURRENT_PROMPT = "CURRENT_CUSTOM_TURN_PROMPT_SENTINEL";
const OLD_TOOL = "OLD_CUSTOM_TURN_TOOL_SENTINEL";
const CURRENT_TOOL = "CURRENT_CUSTOM_TURN_TOOL_SENTINEL";
const HOOK_PROMPT = "CUSTOM_TURN_HOOK_SENTINEL";

function contractTool(description: string, name = "custom_turn_contract") {
  return {
    name,
    label: "Custom turn contract",
    description,
    parameters: Type.Object({ current: Type.Boolean() }),
    execute: async () => ({
      content: [{ type: "text" as const, text: "unused" }],
      details: undefined,
    }),
  };
}

async function loader(
  cwd: string,
  systemPrompt: string,
  hooks?: { beforePrompts: string[]; inputCount: { value: number } },
): Promise<DefaultResourceLoader> {
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: join(cwd, "agent"),
    systemPromptOverride: () => systemPrompt,
    extensionFactories: hooks
      ? [
          (pi) => {
            pi.on("input", () => {
              hooks.inputCount.value += 1;
            });
            pi.on("before_agent_start", (event) => {
              hooks.beforePrompts.push(event.prompt);
              event.systemPromptOptions.sections["custom_turn_hook"] = HOOK_PROMPT;
              return {
                message: {
                  customType: "custom-turn-hook",
                  content: "hook context",
                  display: false,
                },
              };
            });
          },
        ]
      : [],
  });
  await resourceLoader.reload();
  return resourceLoader;
}

it("real SDK: cancellation during custom-turn preparation prevents inference", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-orb-custom-turn-cancel-"));
  let hookStarted: (() => void) | undefined;
  let hookCancelled = false;
  let laterHooks = 0;
  const hookEntered = new Promise<void>((resolve) => {
    hookStarted = resolve;
  });
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      allowModelNetwork: false,
    });
    const faux = fauxProvider({ provider: "custom-turn-cancellation-contract" });
    runtime.registerNativeProvider(faux.provider);
    let requests = 0;
    faux.setResponses([
      () => {
        requests += 1;
        return fauxAssistantMessage("must not run");
      },
    ]);
    const resourceLoader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: join(dir, "agent"),
      extensionFactories: [
        (pi) => {
          pi.on("before_agent_start", async (_event, ctx) => {
            hookStarted?.();
            await new Promise<void>((resolve, reject) => {
              const timeout = setTimeout(resolve, 200);
              ctx.signal?.addEventListener(
                "abort",
                () => {
                  hookCancelled = true;
                  clearTimeout(timeout);
                  reject(ctx.signal?.reason);
                },
                { once: true },
              );
            });
          });
          pi.on("before_agent_start", () => {
            laterHooks += 1;
          });
        },
      ],
    });
    await resourceLoader.reload();
    const manager = SessionManager.inMemory(dir);
    const { session } = await createAgentSession({
      cwd: dir,
      agentDir: join(dir, "agent"),
      sessionManager: manager,
      modelRuntime: runtime,
      settingsManager: SettingsManager.inMemory(),
      resourceLoader,
      model: faux.getModel(),
    });

    const entriesBefore = manager.getEntries();
    const sending = session.sendCustomMessage(
      { customType: "cancelled-custom", content: "cancel me", display: true },
      { triggerTurn: true },
    );
    await hookEntered;
    const aborting = session.abort();
    await Promise.all([sending, aborting]);

    expect(hookCancelled).toBe(true);
    expect(laterHooks).toBe(0);
    expect(requests).toBe(0);
    expect(session.isIdle).toBe(true);
    expect(manager.getEntries()).toEqual(entriesBefore);
    session.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("real SDK: abort stops auth preparation before hooks or inference", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-orb-custom-turn-auth-cancel-"));
  let authStarted: (() => void) | undefined;
  let authCancelled = false;
  const entered = new Promise<void>((resolve) => {
    authStarted = resolve;
  });
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      allowModelNetwork: false,
    });
    const faux = fauxProvider({ provider: "custom-turn-auth-cancellation-contract" });
    runtime.registerNativeProvider(faux.provider);
    let requests = 0;
    let hooks = 0;
    faux.setResponses([
      () => {
        requests += 1;
        return fauxAssistantMessage("must not run");
      },
    ]);
    vi.spyOn(runtime, "hasConfiguredAuth").mockReturnValue(false);
    vi.spyOn(runtime, "checkAuth").mockImplementation(
      async (_provider, options) =>
        await new Promise<never>((_resolve, reject) => {
          authStarted?.();
          const timeout = setTimeout(() => reject(new Error("auth timeout")), 200);
          const cancel = () => {
            authCancelled = true;
            clearTimeout(timeout);
            reject(options?.signal?.reason);
          };
          if (options?.signal?.aborted) cancel();
          else options?.signal?.addEventListener("abort", cancel, { once: true });
        }),
    );
    const resourceLoader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: join(dir, "agent"),
      extensionFactories: [
        (pi) => {
          pi.on("before_agent_start", () => {
            hooks += 1;
          });
        },
      ],
    });
    await resourceLoader.reload();
    const manager = SessionManager.inMemory(dir);
    const { session } = await createAgentSession({
      cwd: dir,
      agentDir: join(dir, "agent"),
      sessionManager: manager,
      modelRuntime: runtime,
      settingsManager: SettingsManager.inMemory(),
      resourceLoader,
      model: faux.getModel(),
    });

    const entriesBefore = manager.getEntries();
    const sending = session
      .sendCustomMessage(
        { customType: "cancelled-auth", content: "cancel me", display: true },
        {
          triggerTurn: true,
        },
      )
      .then(
        () => "resolved" as const,
        () => "rejected" as const,
      );
    await entered;
    await session.abort();

    expect(await sending).toBe("resolved");
    expect(authCancelled).toBe(true);
    expect(hooks).toBe(0);
    expect(requests).toBe(0);
    expect(session.isIdle).toBe(true);
    expect(manager.getEntries()).toEqual(entriesBefore);
    session.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("real SDK: preparation failure releases activity and permits the next custom turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-orb-custom-turn-failure-"));
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      allowModelNetwork: false,
    });
    const faux = fauxProvider({ provider: "custom-turn-failure-contract" });
    runtime.registerNativeProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("recovered")]);
    let fail = true;
    const resourceLoader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: join(dir, "agent"),
      extensionFactories: [
        (pi) => {
          pi.on("before_agent_start", (event) => {
            if (!fail) return;
            fail = false;
            event.systemPromptOptions.sections["INVALID SECTION"] = "invalid";
          });
        },
      ],
    });
    await resourceLoader.reload();
    const manager = SessionManager.inMemory(dir);
    const { session } = await createAgentSession({
      cwd: dir,
      agentDir: join(dir, "agent"),
      sessionManager: manager,
      modelRuntime: runtime,
      settingsManager: SettingsManager.inMemory(),
      resourceLoader,
      model: faux.getModel(),
    });

    const entriesBefore = manager.getEntries();
    await expect(
      session.sendCustomMessage(
        { customType: "broken", content: "broken", display: true },
        {
          triggerTurn: true,
        },
      ),
    ).rejects.toThrow("Invalid system prompt section name");
    expect(session.isIdle).toBe(true);
    expect(manager.getEntries()).toEqual(entriesBefore);

    await session.sendCustomMessage(
      { customType: "recovered", content: "recover", display: true },
      { triggerTurn: true },
    );
    expect(session.isIdle).toBe(true);
    expect(manager.getEntries().filter((entry) => entry.type === "custom_message")).toMatchObject([
      { customType: "recovered" },
    ]);
    session.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("real SDK: a concurrent custom trigger steers the preparing run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-orb-custom-turn-steer-"));
  let hookStarted: (() => void) | undefined;
  let releaseHook: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    hookStarted = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseHook = resolve;
  });
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      allowModelNetwork: false,
    });
    const faux = fauxProvider({ provider: "custom-turn-steer-contract" });
    runtime.registerNativeProvider(faux.provider);
    const requests: unknown[] = [];
    faux.setResponses([
      (context) => {
        requests.push(context.messages);
        return fauxAssistantMessage("complete");
      },
    ]);
    let hooks = 0;
    const resourceLoader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: join(dir, "agent"),
      extensionFactories: [
        (pi) => {
          pi.on("before_agent_start", async () => {
            hooks += 1;
            hookStarted?.();
            await release;
          });
        },
      ],
    });
    await resourceLoader.reload();
    const manager = SessionManager.inMemory(dir);
    const { session } = await createAgentSession({
      cwd: dir,
      agentDir: join(dir, "agent"),
      sessionManager: manager,
      modelRuntime: runtime,
      settingsManager: SettingsManager.inMemory(),
      resourceLoader,
      model: faux.getModel(),
    });

    const first = session.sendCustomMessage(
      { customType: "first", content: "first custom", display: true },
      { triggerTurn: true },
    );
    await entered;
    await session.sendCustomMessage(
      { customType: "second", content: "second custom", display: true },
      { triggerTurn: true },
    );
    releaseHook?.();
    await first;

    expect(hooks).toBe(1);
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0])).toContain("first custom");
    expect(JSON.stringify(requests[0])).toContain("second custom");
    expect(manager.getEntries().filter((entry) => entry.type === "custom_message")).toMatchObject([
      { customType: "first" },
      { customType: "second" },
    ]);
    session.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("real SDK: refreshes changed tools between turns of a custom-triggered run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-orb-custom-turn-tool-refresh-"));
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      allowModelNetwork: false,
    });
    const faux = fauxProvider({ provider: "custom-turn-tool-refresh-contract" });
    runtime.registerNativeProvider(faux.provider);
    const requests: Parameters<typeof getCurrentTools>[0][] = [];
    faux.setResponses([
      (context) => {
        requests.push(context.messages);
        return fauxAssistantMessage(fauxToolCall("first_tool", { current: true }));
      },
      (context) => {
        requests.push(context.messages);
        return fauxAssistantMessage("complete");
      },
    ]);
    const resourceLoader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: join(dir, "agent"),
      extensionFactories: [
        (pi) => {
          pi.on("before_agent_start", () => {
            pi.setActiveTools(["first_tool"]);
          });
          pi.on("tool_result", () => {
            pi.setActiveTools(["second_tool"]);
          });
        },
      ],
    });
    await resourceLoader.reload();
    const manager = SessionManager.inMemory(dir);
    const { session } = await createAgentSession({
      cwd: dir,
      agentDir: join(dir, "agent"),
      sessionManager: manager,
      modelRuntime: runtime,
      settingsManager: SettingsManager.inMemory(),
      resourceLoader,
      model: faux.getModel(),
      customTools: [contractTool("first", "first_tool"), contractTool("second", "second_tool")],
      tools: ["first_tool", "second_tool"],
    });

    await session.sendCustomMessage(
      { customType: "tool-refresh", content: "refresh tools", display: true },
      { triggerTurn: true },
    );

    expect(requests).toHaveLength(2);
    expect(getCurrentTools(requests[0] ?? [])).toMatchObject([
      { name: "first_tool", description: "first" },
    ]);
    expect(getCurrentTools(requests[1] ?? [])).toMatchObject([
      { name: "second_tool", description: "second" },
    ]);
    session.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("real SDK: prepares current prompt, tools, and hooks before an idle custom-triggered turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-orb-custom-turn-"));
  try {
    const sessionDir = join(dir, "sessions");
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      allowModelNetwork: false,
    });
    const faux = fauxProvider({ provider: "custom-turn-contract" });
    runtime.registerNativeProvider(faux.provider);
    const model = faux.getModel();
    const manager = SessionManager.create(dir, sessionDir);

    let initialRequest: unknown;
    faux.setResponses([
      (context) => {
        initialRequest = context.messages;
        return fauxAssistantMessage("initial complete");
      },
    ]);
    const initial = await createAgentSession({
      cwd: dir,
      agentDir: join(dir, "agent"),
      sessionManager: manager,
      modelRuntime: runtime,
      settingsManager: SettingsManager.inMemory(),
      resourceLoader: await loader(dir, OLD_PROMPT),
      model,
      customTools: [contractTool(OLD_TOOL)],
      tools: ["custom_turn_contract"],
    });
    await initial.session.prompt("initial user prompt");
    const initialMessages = initialRequest as Parameters<typeof getCurrentSystemPrompt>[0];
    expect(getCurrentSystemPrompt(initialMessages)).toContain(OLD_PROMPT);
    expect(getCurrentTools(initialMessages)).toMatchObject([
      { name: "custom_turn_contract", description: OLD_TOOL },
    ]);
    const file = manager.getSessionFile();
    expect(file).toBeDefined();
    initial.session.dispose();
    if (!file) return;

    const beforePrompts: string[] = [];
    const inputCount = { value: 0 };
    let request: unknown;
    faux.setResponses([
      (context) => {
        request = context.messages;
        return fauxAssistantMessage("restart complete");
      },
    ]);
    const reopenedManager = SessionManager.open(file, sessionDir, dir);
    const reopened = await createAgentSession({
      cwd: dir,
      agentDir: join(dir, "agent"),
      sessionManager: reopenedManager,
      modelRuntime: runtime,
      settingsManager: SettingsManager.inMemory(),
      resourceLoader: await loader(dir, CURRENT_PROMPT, { beforePrompts, inputCount }),
      model,
      customTools: [contractTool(CURRENT_TOOL)],
      tools: ["custom_turn_contract"],
    });

    await reopened.session.sendCustomMessage(
      {
        customType: "pi-orb.host-restarted",
        content: "restart custom content",
        display: true,
        details: { bootId: "boot-current" },
      },
      { triggerTurn: true },
    );

    expect(inputCount.value).toBe(0);
    expect(beforePrompts).toEqual(["restart custom content"]);
    const requestMessages = request as Parameters<typeof getCurrentSystemPrompt>[0];
    const effectivePrompt = getCurrentSystemPrompt(requestMessages);
    const effectiveTools = getCurrentTools(requestMessages);
    expect(effectivePrompt).toContain(CURRENT_PROMPT);
    expect(effectivePrompt).toContain(HOOK_PROMPT);
    expect(effectivePrompt).not.toContain(OLD_PROMPT);
    expect(effectiveTools).toMatchObject([
      { name: "custom_turn_contract", description: CURRENT_TOOL },
    ]);
    expect(JSON.stringify(effectiveTools)).not.toContain(OLD_TOOL);
    // Mid-conversation-capable providers intentionally retain historical system deltas.
    expect(JSON.stringify(requestMessages)).toContain(OLD_PROMPT);

    const entries = reopenedManager.getEntries();
    expect(
      entries.filter(
        (entry) => entry.type === "custom_message" && entry.customType === "pi-orb.host-restarted",
      ),
    ).toMatchObject([
      {
        customType: "pi-orb.host-restarted",
        content: "restart custom content",
        display: true,
        details: { bootId: "boot-current" },
      },
    ]);
    expect(
      entries.filter(
        (entry) => entry.type === "custom_message" && entry.customType === "custom-turn-hook",
      ),
    ).toHaveLength(1);
    expect(
      entries.filter((entry) => entry.type === "message" && entry.message.role === "user"),
    ).toHaveLength(1);
    reopened.session.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

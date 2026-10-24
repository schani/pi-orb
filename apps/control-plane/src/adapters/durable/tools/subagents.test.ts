import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineTool,
  Harness,
  InboxDoc,
  MemoryStorage,
  type Storage,
  type SubmissionId,
  type TaskId,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { promptExtension } from "../prompt.ts";
import { ChildReceipts, createDurableTools } from "./index.ts";
import { ChildAnchor } from "./subagents.ts";
import { toolData, wait } from "./testkit/subagent-wait.ts";

const ctx = BACKGROUND_CONTEXT;
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function setup(
  responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0],
  options: {
    faux?: Parameters<typeof fauxProvider>[0];
    tools?: Parameters<typeof createDurableTools>[0];
  } = {},
) {
  const faux = fauxProvider(options.faux);
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const tools = createDurableTools(options.tools);
  const registry = createRegistry();
  registry.install(tools.extension);
  registry.install(tools.childExtension);
  return { models, registry, tools };
}
function nativeCall(name: string, args: Record<string, unknown>, id = name) {
  return fauxToolCall(
    "codemode",
    { code: `text(await tools.${name}(${JSON.stringify(args)}));` },
    { id },
  );
}
function nativeData(result: { content: readonly { type: string; text?: string }[] } | undefined) {
  expect(result?.content[0]).toMatchObject({
    type: "text",
    text: expect.stringMatching(/^Script completed\n/),
  });
  const body = result?.content[1];
  expect(body?.type).toBe("text");
  return JSON.parse(body?.text ?? "");
}
function initial(tools: ReturnType<typeof createDurableTools>) {
  return {
    agent: {
      model: { provider: "faux", modelId: "faux-1" },
      instructions: "shared instructions",
      cwd: "/shared",
      modelTools: tools.modelTools,
      extensions: { remove: [tools.childExtension] },
    },
  };
}

it("rejects direct model subagent calls before creating a child", async () => {
  const results: unknown[] = [];
  const s = setup([
    fauxAssistantMessage(fauxToolCall("subagent", { prompt: "forbidden direct child" }), {
      stopReason: "toolUse",
    }),
    (request) => {
      results.push(...request.messages.filter((message) => message.role === "toolResult"));
      return fauxAssistantMessage("parent done");
    },
  ]);
  const storage = new MemoryStorage();
  const harness = await Harness.open(storage, s, ctx);
  s.tools.bindTaskAbort(harness.abortTask.bind(harness));
  try {
    const root = await harness.root(ctx, initial(s.tools));
    harness.resume();
    await (await root.submit({ type: "input", content: "parent" }, ctx)).wait(ctx);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ toolName: "subagent", isError: true });
    expect(JSON.stringify(results)).toContain("Tool subagent is not available");
    expect(
      Object.keys((await harness.snapshot(ChildReceipts, root.id, ctx))?.children ?? {}),
    ).toHaveLength(0);
    expect(
      (await storage.scanConversations({}, 100, undefined, ctx)).items.filter((c) => c.owner),
    ).toHaveLength(0);
  } finally {
    await harness.close(ctx);
    await s.tools.close();
  }
});

it("cancels only the selected child; root abort drains its sibling", async () => {
  const startedA = barrier(),
    startedB = barrier();
  const respond: FauxResponseFactory = async (request, options) => {
    const user = request.messages.find((m) => m.role === "user");
    const text = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content);
    if (text?.includes("child-a") || text?.includes("child-b")) {
      (text.includes("child-a") ? startedA : startedB).resolve();
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) resolve();
        else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return fauxAssistantMessage("", { stopReason: "aborted" });
    }
    const results = request.messages.filter((m) => m.role === "toolResult");
    if (results.length === 2) {
      for (const result of results) expect(result.isError).toBe(false);
      await Promise.all([startedA.promise, startedB.promise]);
      const id = nativeData(results[0]).agent_id;
      return fauxAssistantMessage(nativeCall("cancel_subagent", { agent_id: id }), {
        stopReason: "toolUse",
      });
    }
    return fauxAssistantMessage("parent done");
  };
  const s = setup([
    fauxAssistantMessage(
      [
        nativeCall("subagent", { prompt: "child-a" }, "a"),
        nativeCall("subagent", { prompt: "child-b", description: "Existing child header" }, "b"),
      ],
      { stopReason: "toolUse" },
    ),
    ...Array(5).fill(respond),
  ]);
  const harness = await Harness.open(new MemoryStorage(), s, ctx);
  s.tools.bindTaskAbort(harness.abortTask.bind(harness));
  try {
    const root = await harness.root(ctx, initial(s.tools));
    harness.resume();
    await (await root.submit({ type: "input", content: "parent" }, ctx)).wait(ctx);
    const entries = await root.entries({}, 100, undefined, ctx);
    expect(JSON.stringify(entries.items)).toContain('\\"status\\":\\"aborted\\"');
    expect(
      entries.items
        .filter((entry) => entry.kind === "orb.subagent-task")
        .map((entry) => entry.data),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ prompt: "child-a", description: "" }),
        expect.objectContaining({ prompt: "child-b", description: "Existing child header" }),
      ]),
    );
    const inspection = await harness.inspect(ctx);
    expect(inspection.tasks.filter((t) => t.record.kind === "orb.child")).toHaveLength(1);
    await root.abort(ctx, { background: true });
    expect((await harness.inspect(ctx)).tasks).toHaveLength(0);
  } finally {
    await harness.close(ctx);
    await s.tools.close();
  }
});

it("reopens persisted anchors without recreating children or rerunning the spawning tool", async () => {
  const childStarted = barrier();
  const respond: FauxResponseFactory = async (request, options) => {
    if (
      JSON.stringify(request.messages).includes('"child"') &&
      !request.messages.some((m) => m.role === "toolResult")
    ) {
      childStarted.resolve();
      await new Promise<void>((resolve) =>
        options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
      return fauxAssistantMessage("", { stopReason: "aborted" });
    }
    return fauxAssistantMessage("parent done");
  };
  const s = setup([
    fauxAssistantMessage(nativeCall("subagent", { prompt: "child" }), { stopReason: "toolUse" }),
    respond,
    respond,
  ]);
  const backing = new MemoryStorage();
  // Close the scheduler while preserving the committed backend, as reopening an on-disk store does.
  const storage = new Proxy(backing, {
    get(target, key) {
      if (key === "close") return async () => {};
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Storage;
  let harness = await Harness.open(storage, s, ctx);
  s.tools.bindTaskAbort(harness.abortTask.bind(harness));
  try {
    const root = await harness.root(ctx, initial(s.tools));
    harness.resume();
    await (await root.submit({ type: "input", content: "parent" }, ctx)).wait(ctx);
    await childStarted.promise;
    const before = await harness.snapshot(ChildReceipts, root.id, ctx);
    expect(Object.keys(before?.children ?? {})).toHaveLength(1);
    await harness.close(ctx);
    const recovered = setup([fauxAssistantMessage("recovered child")]);
    harness = await Harness.open(storage, recovered, ctx);
    const reopened = await harness.root(ctx);
    harness.resume();
    const anchor = Object.values(before?.children ?? {})[0];
    expect(anchor).toBeDefined();
    if (!anchor) return;
    await harness.waitForTask(anchor.anchor as never, ctx);
    expect(await harness.snapshot(ChildReceipts, reopened.id, ctx)).toEqual(before);
    expect(
      (await storage.scanConversations({}, 100, undefined, ctx)).items.filter((c) => c.owner),
    ).toHaveLength(1);
    const record = await storage.task(anchor.anchor as never, ctx);
    expect(JSON.stringify(record)).toContain("recovered child");
    expect(
      (await reopened.entries({}, 100, undefined, ctx)).items.filter(
        (entry) => entry.kind === "orb.subagent-task",
      ),
    ).toHaveLength(1);
    await recovered.tools.close();
  } finally {
    await harness.close(ctx);
    await s.tools.close();
    await backing.close(ctx);
  }
});

it("children inherit pinned instructions but neither see nor start subagents", async () => {
  const prompts = { root: [] as string[], child: [] as string[] };
  const capture = (request: Parameters<FauxResponseFactory>[0]) => {
    const child = JSON.stringify(request.messages.find((m) => m.role === "user")?.content).includes(
      "child prompt",
    );
    const section = request.messages.findLast(
      (m) => m.role === "system" && m.sections?.["orb-instructions"] !== undefined,
    );
    prompts[child ? "child" : "root"].push(
      section?.role === "system" ? (section.sections?.["orb-instructions"] ?? "") : "",
    );
  };
  const childTools: { name: string; description: string }[][] = [];
  const childResults: string[] = [];
  const respond: FauxResponseFactory = async (request) => {
    capture(request);
    const user = request.messages.find((m) => m.role === "user");
    if (JSON.stringify(user?.content).includes("child prompt")) {
      const offered = new Map<string, string>();
      for (const m of request.messages)
        if (m.role === "system") {
          for (const t of m.toolsRemoved ?? []) offered.delete(t.name);
          for (const t of m.toolsAdded ?? []) offered.set(t.name, t.description);
        }
      childTools.push([...offered].map(([name, description]) => ({ name, description })));
      const result = request.messages.find((m) => m.role === "toolResult");
      if (!result) {
        return fauxAssistantMessage(
          fauxToolCall("codemode", { code: "text(await tools.subagent({prompt: 'grandchild'}));" }),
          { stopReason: "toolUse" },
        );
      }
      childResults.push(JSON.stringify(result.content));
      return fauxAssistantMessage("child done");
    }
    const last = request.messages.filter((m) => m.role === "toolResult").at(-1);
    if (last?.toolCallId === "subagent")
      return fauxAssistantMessage(
        nativeCall("get_subagent_result", {
          agent_id: nativeData(last).agent_id,
          wait: true,
        }),
        { stopReason: "toolUse" },
      );
    return fauxAssistantMessage("parent done");
  };
  const s = setup(
    [
      (request) => {
        capture(request);
        return fauxAssistantMessage(nativeCall("subagent", { prompt: "child prompt" }), {
          stopReason: "toolUse",
        });
      },
      ...Array(4).fill(respond),
    ],
    {
      tools: {
        additionalTools: [
          defineTool({
            name: "orb_spawn",
            description: "Create a same-project orb with a prompt.",
            parameters: Type.Object({ prompt: Type.String() }),
            execute: async () => ({ output: [{ type: "text", text: "spawned" }] }),
          }),
        ],
      },
    },
  );
  s.registry.install(promptExtension("PINNED_PROMPT"));
  const storage = new MemoryStorage();
  const harness = await Harness.open(storage, s, ctx);
  s.tools.bindTaskAbort(harness.abortTask.bind(harness));
  try {
    const root = await harness.root(ctx, initial(s.tools));
    harness.resume();
    await (await root.submit({ type: "input", content: "parent" }, ctx)).wait(ctx);
    const tagged = (text: string) => `<orb-instructions>\n${text}\n</orb-instructions>`;
    const childNote = `\n\n- You are a subagent. Your parent started you in this same orb; you share its filesystem.
- To communicate with your parent agent you have \`notify_parent\`. Do not use \`orb_send\` for that!!!
- Do not start subagents or orbs!`;
    expect(prompts.child).toEqual([
      tagged(`PINNED_PROMPT${childNote}`),
      tagged(`PINNED_PROMPT${childNote}`),
    ]);
    expect(prompts.root[0]).toBe(tagged("PINNED_PROMPT"));
    expect(prompts.root.at(-1)).toBe(tagged("PINNED_PROMPT"));
    for (const prompt of prompts.root) expect(prompt).not.toContain(childNote.trim());
    expect(childTools).toHaveLength(2);
    for (const tools of childTools) {
      expect(tools.map((t) => t.name)).toEqual(["codemode"]);
      expect(tools[0]?.description).not.toMatch(/subagent/i);
      expect(tools[0]?.description).not.toContain("orb_spawn");
    }
    expect(childResults[0]).toContain("tools.subagent does not exist");
    expect(JSON.stringify(await root.entries({}, 100, undefined, ctx))).toContain("child done");
    const conversations = await storage.scanConversations({}, 100, undefined, ctx);
    expect(conversations.items.filter((c) => c.owner)).toHaveLength(1);
  } finally {
    await harness.close(ctx);
    await s.tools.close();
  }
});

it("starts a child on the selected model and rejects an unavailable one before creating it", async () => {
  const childModels: string[] = [];
  const results: string[] = [];
  const respond: FauxResponseFactory = async (request, _options, _state, model) => {
    const user = request.messages.find((m) => m.role === "user");
    if (JSON.stringify(user?.content).includes("child prompt")) {
      childModels.push(model.id);
      return fauxAssistantMessage("child done");
    }
    const outcomes = request.messages.filter((m) => m.role === "toolResult");
    if (outcomes.length === 2) {
      results.push(...outcomes.map((m) => JSON.stringify(m.content)));
      return fauxAssistantMessage(
        nativeCall("get_subagent_result", {
          agent_id: nativeData(outcomes[0]).agent_id,
          wait: true,
        }),
        { stopReason: "toolUse" },
      );
    }
    if (outcomes.length === 3) results.push(JSON.stringify(outcomes[2]?.content));
    return fauxAssistantMessage("parent done");
  };
  const s = setup(
    [
      fauxAssistantMessage(
        [
          nativeCall("subagent", { prompt: "child prompt", model: "Terra" }, "a"),
          nativeCall("subagent", { prompt: "other prompt", model: "Luna" }, "b"),
        ],
        { stopReason: "toolUse" },
      ),
      ...Array(4).fill(respond),
    ],
    {
      faux: {
        provider: "openai-codex",
        models: [
          { id: "gpt-6.1-sol", input: ["text", "image"] },
          { id: "gpt-5.6-terra", input: ["text", "image"] },
        ],
      },
    },
  );
  const storage = new MemoryStorage();
  const harness = await Harness.open(storage, s, ctx);
  s.tools.bindTaskAbort(harness.abortTask.bind(harness));
  try {
    const root = await harness.root(ctx, {
      agent: {
        ...initial(s.tools).agent,
        model: { provider: "openai-codex", modelId: "gpt-6.1-sol" },
      },
    });
    harness.resume();
    await (await root.submit({ type: "input", content: "parent" }, ctx)).wait(ctx);
    expect(childModels).toEqual(["gpt-5.6-terra"]);
    expect(results[1]).toContain("Model unavailable: Luna");
    expect(results[2]).toContain('\\"model\\":\\"Terra\\"');
    const conversations = await storage.scanConversations({}, 100, undefined, ctx);
    expect(conversations.items.filter((c) => c.owner)).toHaveLength(1);
  } finally {
    await harness.close(ctx);
    await s.tools.close();
  }
});

it("parent input interrupts a real child wait without aborting its anchor or consuming the inbox", async () => {
  const entered = barrier(),
    release = barrier();
  const s = setup([
    async () => {
      entered.resolve();
      await release.promise;
      return fauxAssistantMessage("child receipt");
    },
  ]);
  const harness = await Harness.open(new MemoryStorage(), s, ctx);
  s.tools.bindTaskAbort(harness.abortTask.bind(harness));
  try {
    const root = await harness.root(ctx, initial(s.tools));
    const api = {
      conversationId: root.id,
      taskId: 42 as TaskId,
      callId: "spawn",
      models: s.models,
      commit: root.commit.bind(root),
      snapshot: harness.snapshot.bind(harness),
      getTask: harness.getTask.bind(harness),
      waitForTask: harness.waitForTask.bind(harness),
      watchDoc: harness.watchDoc.bind(harness),
    } as unknown as ToolExecutionApi;
    const spawn = s.tools.catalog.registrations().find((tool) => tool.name === "subagent");
    if (!spawn) throw new Error("Missing subagent tool");
    const agentId = toolData(await spawn.execute({ prompt: "work" }, api, ctx)).agent_id;
    harness.resume();
    await entered.promise;
    await root.commit(async (tx) => {
      (await tx.doc(InboxDoc, root.id)).items.push({
        id: 999 as SubmissionId,
        mode: "steer",
        content: [{ type: "text", text: "parent input" }],
      });
    }, ctx);
    const yielded = await wait.execute({ agent_id: agentId, wait: true }, api, ctx);
    expect(yielded.isError).not.toBe(true);
    expect(toolData(yielded)).toMatchObject({ status: "running", interrupted: "parent_input" });
    const anchor = (await harness.inspect(ctx)).tasks.find(
      (task) => task.record.kind === ChildAnchor.definition.name,
    )?.record;
    if (!anchor) throw new Error("Missing ChildAnchor");
    expect(anchor.state.status).not.toBe("terminal");
    expect(anchor.abortRequested).toBe(false);
    expect((await harness.snapshot(InboxDoc, root.id, ctx))?.items).toHaveLength(1);
    release.resolve();
    await harness.waitForTask(anchor.id, ctx);
    expect(toolData(await wait.execute({ agent_id: agentId, wait: true }, api, ctx))).toMatchObject(
      {
        status: "completed",
        receipt: { result: { output: "child receipt" } },
      },
    );
  } finally {
    release.resolve();
    await harness.close(ctx);
    await s.tools.close();
  }
});

it("cancels a restart-parked child anchor before waiting for its terminal receipt", async () => {
  const { MemoryAgentPersistence } = await import("../memory-persistence.testkit.ts");
  const authority = new MemoryAgentPersistence();
  const storage = (await authority.openOrb("parked-child", false))._unsafeUnwrap().storage;
  const s = setup([
    fauxAssistantMessage(nativeCall("cancel_subagent", { agent_id: "child" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("cancelled"),
  ]);
  let harness = await Harness.open(storage, s, ctx);
  s.tools.bindTaskAbort(harness.abortTask.bind(harness));
  try {
    const root = await harness.root(ctx, initial(s.tools));
    const id = await root.commit(
      (tx) =>
        tx.createTask(
          ChildAnchor,
          { prompt: "must not run", description: "parked" },
          { ownership: { kind: "conversation" }, background: true },
        ),
      ctx,
    );
    await root.commit(async (tx) => {
      (await tx.doc(ChildReceipts, root.id)).children.child = {
        anchor: id,
        prompt: "must not run",
        description: "parked",
      };
    }, ctx);
    await harness.close(ctx);
    await storage.commit(
      [{ type: "task", value: { ...(await storage.task(id, ctx))!, restarts: 5 } }],
      ctx,
    );
    harness = await Harness.open(storage, s, ctx);
    const reopened = (await harness.conversation(root.id, ctx))!;
    s.tools.bindTaskAbort(harness.abortTask.bind(harness));
    harness.resume();
    await (await reopened.submit({ type: "input", content: "cancel parked child" }, ctx)).wait(ctx);
    const entries = await reopened.entries({}, 100, undefined, ctx);
    const result = entries.items
      .flatMap((entry) => entry.model ?? [])
      .find((message) => message.role === "toolResult");
    expect(result?.role === "toolResult" ? nativeData(result) : undefined).toMatchObject({
      status: "aborted",
    });
    expect(await harness.getTask(id, ctx)).toMatchObject({
      state: { status: "terminal", outcome: { status: "aborted" } },
    });
  } finally {
    await harness.close(ctx);
    await s.tools.close();
  }
});

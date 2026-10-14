import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineTool,
  Harness,
  InboxDoc,
  MemoryStorage,
  type SubmissionId,
  type TaskId,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { ChildAnchor, subagentTools } from "./subagents.ts";
import { deferred } from "./testkit/subagent-wait.ts";

it("real Harness watch buffers steer before start; ChildAnchor survives and later settles", async () => {
  const ctx = BACKGROUND_CONTEXT;
  const entered = deferred();
  const releaseChild = deferred();
  const acquired = deferred();
  const releaseWatch = deferred();
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  faux.setResponses([
    async () => {
      entered.resolve();
      await releaseChild.promise;
      return fauxAssistantMessage("child receipt");
    },
  ]);
  const registry = createRegistry();
  registry.install({
    name: "wait-test",
    tasks: [ChildAnchor],
    tools: [
      defineTool({
        name: "codemode",
        description: "unused child callable",
        parameters: Type.Object({}),
        execute: async () => ({}),
      }),
    ],
  });
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
  const root = await harness.root(ctx, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
  });
  const api = {
    conversationId: root.id,
    taskId: 42 as TaskId,
    callId: "spawn",
    models,
    commit: root.commit.bind(root),
    snapshot: harness.snapshot.bind(harness),
    getTask: harness.getTask.bind(harness),
    waitForTask: harness.waitForTask.bind(harness),
    watchDoc: (async (...parameters: Parameters<typeof harness.watchDoc>) => {
      const watch = await harness.watchDoc(...parameters);
      acquired.resolve();
      await releaseWatch.promise;
      return watch;
    }) as ToolExecutionApi["watchDoc"],
  } as unknown as ToolExecutionApi;
  const spawn = subagentTools.find((tool) => tool.name === "subagent") as ToolRegistration;
  const wait = subagentTools.find(
    (tool) => tool.name === "get_subagent_result",
  ) as ToolRegistration;
  let execution: ReturnType<typeof wait.execute> | undefined;
  try {
    const started = await spawn.execute({ prompt: "work" }, api, ctx);
    const agentId = JSON.parse(started.content?.find((block) => block.type === "text")?.text ?? "")
      .agent_id as string;
    harness.resume();
    await entered.promise;
    // Baseline reaches waitForTask, not watchDoc: fail finitely without a timer.
    const waiting = deferred();
    const original = api.waitForTask;
    api.waitForTask = async (id, context) => {
      waiting.resolve();
      return original(id, context);
    };
    execution = wait.execute({ agent_id: agentId, wait: true }, api, ctx);
    expect(
      await Promise.race([
        acquired.promise.then(() => "acquired"),
        waiting.promise.then(() => "waiting"),
      ]),
    ).toBe("acquired");
    await root.commit(async (tx) => {
      (await tx.doc(InboxDoc, root.id)).items.push({
        id: 999 as SubmissionId,
        mode: "steer",
        content: [{ type: "text", text: "parent input" }],
      });
    }, ctx);
    releaseWatch.resolve();
    const yielded = await execution;
    expect(yielded.isError).not.toBe(true);
    expect(
      JSON.parse(yielded.content?.find((block) => block.type === "text")?.text ?? ""),
    ).toMatchObject({
      status: "running",
      interrupted: "parent_input",
    });
    const inspection = await harness.inspect(ctx);
    const anchor = inspection.tasks.find(
      (task) => task.record.kind === ChildAnchor.definition.name,
    )?.record;
    if (!anchor) throw new Error("Missing ChildAnchor");
    expect(anchor.state.status).not.toBe("terminal");
    expect(anchor.abortRequested).toBe(false);
    expect((await harness.snapshot(InboxDoc, root.id, ctx))?.items).toHaveLength(1);
    releaseChild.resolve();
    await harness.waitForTask(anchor.id, ctx);
    const final = await wait.execute({ agent_id: agentId, wait: true }, api, ctx);
    expect(
      JSON.parse(final.content?.find((block) => block.type === "text")?.text ?? ""),
    ).toMatchObject({
      status: "completed",
      receipt: { result: { output: "child receipt" } },
    });
  } finally {
    releaseWatch.resolve();
    releaseChild.resolve();
    await execution?.catch(() => {});
    await harness.close(ctx);
  }
});

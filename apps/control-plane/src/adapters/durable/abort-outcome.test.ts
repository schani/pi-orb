import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { ServerFrame } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { okAsync, ResultAsync } from "neverthrow";
import { expect, it } from "vitest";
import { LazyExecutionEnv } from "../execution-client/lazy-env.ts";
import { DurableAgent } from "./agent.ts";
import { executionWaitProgress } from "./execution-wait-progress.ts";
import { createDurableTools } from "./tools/index.ts";

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("publishes Native held-acquisition abort without an assistant terminal or summary, then completes new input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "abort-outcome-"));
  const release = latch(),
    publicWait = latch(),
    laterEntered = latch(),
    laterRelease = latch();
  const storage = new MemoryStorage();
  const remote = new NodeExecutionEnv({ cwd: directory });
  let effects = 0;
  const exec = remote.exec.bind(remote);
  remote.exec = async (...args) => {
    effects++;
    return exec(...args);
  };
  const env = new LazyExecutionEnv({
    cwd: "",
    acquire: (ctx, publish) =>
      ResultAsync.fromSafePromise(
        (async () => {
          await publish?.();
          await Promise.race([
            release.promise,
            new Promise<void>((done) => {
              if (ctx.abortSignal?.aborted) done();
              else ctx.abortSignal?.addEventListener("abort", () => done(), { once: true });
            }),
          ]);
          return remote;
        })(),
      ),
  });
  const bundle = createDurableTools();
  const registry = createRegistry();
  registry.install({
    name: "held",
    tools: bundle.modelTools.map((tool) => ({
      ...tool,
      execute: (args, api, ctx) =>
        tool.execute(
          args as Parameters<typeof tool.execute>[0],
          executionWaitProgress(api, ctx, () => {}),
          ctx,
        ),
    })),
  });
  const models = createModels(),
    faux = fauxProvider();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage("BEFORE_DONE"),
    fauxAssistantMessage(
      fauxToolCall("codemode", {
        code: 'text(await tools.bash({command:"touch MUST_NOT_EXIST"}));',
      }),
      { stopReason: "toolUse" },
    ),
    async () => {
      laterEntered.resolve();
      await laterRelease.promise;
      return fauxAssistantMessage("AFTER_DONE");
    },
  ]);
  const summaries: string[] = [];
  const edges: string[] = [];
  const agent = (
    await DurableAgent.open({
      orbId: "orb",
      storage,
      models,
      registry,
      env,
      instructions: "PRIVATE_INSTRUCTION",
      checkoutCommit: null,
      initialSettings: { model: { provider: "faux", id: "faux-1" }, thinkingLevel: "off" },
      edge: (code) => {
        edges.push(code);
        return okAsync(undefined);
      },
      turnSummary: {
        task: new NoSimulationTask("abort-outcome", false),
        summarizer: {
          summarize: (input) => {
            summaries.push(input.transcript);
            return okAsync("summary");
          },
        },
      },
    })
  )._unsafeUnwrap();
  const frames: ServerFrame[] = [];
  agent.subscribe((frame) => {
    frames.push(frame);
    if (
      frame.type === "runtime.event" &&
      frame.event.type === "tool_state" &&
      frame.event.message === "Waiting for execution."
    )
      publicWait.resolve();
  });
  const input = (messageId: string) => ({
    baseUrl: "central",
    messageId,
    messageIds: [messageId],
    content: [{ type: "text" as const, text: messageId }],
  });
  const before = randomUUID(),
    cancelled = randomUUID(),
    later = randomUUID();
  const finished = () =>
    frames.flatMap((frame) =>
      frame.type === "runtime.event" && frame.event.type === "operation_finished"
        ? [frame.event]
        : [],
    );
  try {
    (await agent.deliver(input(before)))._unsafeUnwrap();
    (await agent.waitForIdle())._unsafeUnwrap();
    const checkpoint = frames.length;
    (await agent.deliver(input(cancelled)))._unsafeUnwrap();
    await publicWait.promise;
    const waiting = frames
      .flatMap((frame) =>
        frame.type === "runtime.event" && frame.event.type === "tool_state" ? [frame.event] : [],
      )
      .at(-1)!;
    expect(effects).toBe(0);
    expect(
      (
        await agent.request("scoped", { type: "abort", operationId: waiting.operationId })
      )._unsafeUnwrap(),
    ).toMatchObject({ type: "accepted", operationId: waiting.operationId });
    (await agent.waitForIdle())._unsafeUnwrap();
    expect(agent.health()).toMatchObject({ status: "ready", activity: "idle" });
    expect(effects).toBe(0);
    expect(await readdir(directory)).toEqual([]);
    const abortFinished = frames
      .slice(checkpoint)
      .flatMap((frame) =>
        frame.type === "runtime.event" && frame.event.type === "operation_finished"
          ? [frame.event]
          : [],
      );
    expect(abortFinished).toEqual([
      { type: "operation_finished", operationId: waiting.operationId, outcome: "aborted" },
    ]);
    const records = agent.snapshot()._unsafeUnwrap().records;
    expect(
      records.filter(
        (record) =>
          record.type === "message" &&
          record.role === "assistant" &&
          record.finishReason === "aborted",
      ),
    ).toEqual([]);
    expect(JSON.stringify(records)).not.toContain("PRIVATE_INSTRUCTION");
    expect(edges.filter((code) => code === "harness.summary_queued")).toHaveLength(1);
    release.resolve();
    (await agent.deliver(input(later)))._unsafeUnwrap();
    await laterEntered.promise;
    for (const historical of [before, cancelled])
      expect(
        (
          await agent.request(`historical:${historical}`, {
            type: "abort",
            operationId: `inbox:${historical}`,
          })
        )._unsafeUnwrap(),
      ).toMatchObject({ type: "rejected", error: { code: "stale_operation" } });
    laterRelease.resolve();
    (await agent.waitForIdle())._unsafeUnwrap();
    expect(finished().map((event) => event.outcome)).toEqual(["completed", "aborted", "completed"]);
    expect(finished().map((event) => event.operationId)).toEqual(
      Array(3).fill(waiting.operationId),
    );
    expect(edges.filter((code) => code === "harness.summary_queued")).toHaveLength(2);
    expect(JSON.stringify(agent.snapshot()._unsafeUnwrap().records)).toContain("AFTER_DONE");
    expect(effects).toBe(0);
  } finally {
    release.resolve();
    laterRelease.resolve();
    await agent.close();
    await bundle.close();
    await env.cleanup(BACKGROUND_CONTEXT);
    await rm(directory, { recursive: true, force: true });
  }
  expect(summaries).toHaveLength(2);
  expect(summaries[0]).toContain("BEFORE_DONE");
  expect(summaries[1]).toContain("AFTER_DONE");
  expect(summaries[1]).not.toContain("MUST_NOT_EXIST");
});

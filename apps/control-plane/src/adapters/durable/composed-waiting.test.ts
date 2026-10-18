import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineTool, MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { ServerFrame } from "@pi-orb/protocol";
import { ResultAsync } from "neverthrow";
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

it.each(["abort", "ready"] as const)(
  "composed codemode preserves held execution wait across nested progress: %s",
  async (outcome) => {
    const directory = await mkdtemp(join(tmpdir(), "composed-wait-"));
    const waiting = latch(),
      release = latch(),
      progress = latch(),
      finishProgress = latch(),
      pulseEntered = latch();
    const allowModel = latch(),
      modelCall = latch(),
      shell = latch();
    const finalModel = latch(),
      allowFinal = latch(),
      committed = latch(),
      publicWait = latch(),
      publicProgress = latch();
    let progressArmed = false;
    const remote = new NodeExecutionEnv({ cwd: directory });
    const exec = remote.exec.bind(remote);
    let effects = 0;
    remote.exec = async (...args) => {
      effects++;
      const result = await exec(...args);
      shell.resolve();
      return result;
    };
    const env = new LazyExecutionEnv({
      cwd: "",
      acquire: (ctx, publish) =>
        ResultAsync.fromSafePromise(
          (async () => {
            await pulseEntered.promise;
            await publish?.();
            waiting.resolve();
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
    const bundle = createDurableTools({
      additionalTools: [
        defineTool({
          name: "pulse",
          description: "controlled nested progress",
          parameters: Type.Object({}),
          execute: async (_args, api, ctx) => {
            pulseEntered.resolve();
            await publicWait.promise;
            progressArmed = true;
            await api.details({ progress: 1 }, ctx);
            progress.resolve();
            await finishProgress.promise;
            return { output: [{ type: "text", text: "pulse" }] };
          },
        }),
      ],
    });
    const registry = createRegistry();
    // The production outer registration owns LazyExecutionEnv wait publication.
    registry.install({
      ...bundle.extension,
      name: "composed",
      tools: (bundle.extension.tools ?? []).map((tool) => ({
        ...tool,
        execute: async (args, api, ctx) => {
          const progressApi = executionWaitProgress(api, ctx, () => {});
          try {
            return await tool.execute(args as Parameters<typeof tool.execute>[0], progressApi, ctx);
          } finally {
            await api.env?.cleanup(BACKGROUND_CONTEXT);
          }
        },
      })),
    });
    const models = createModels(),
      faux = fauxProvider();
    models.setProvider(faux.provider);
    const prompts: string[] = [];
    faux.setResponses([
      async (request) => {
        prompts.push(JSON.stringify(request));
        modelCall.resolve();
        await allowModel.promise;
        return fauxAssistantMessage(
          fauxToolCall("codemode", {
            code: 'await Promise.all([tools.bash({command:"echo changed > FIRST_COMMAND; printf VM_EXECUTED_ONCE"}), tools.pulse({})]);',
          }),
          { stopReason: "toolUse" },
        );
      },
      async () => {
        finalModel.resolve();
        await allowFinal.promise;
        return fauxAssistantMessage("READY_VM_DONE");
      },
      fauxAssistantMessage("FUTURE_CENTRAL_DONE"),
    ]);
    const agent = (
      await DurableAgent.open({
        orbId: "orb",
        storage: new MemoryStorage(),
        models,
        registry,
        env,
        envFor: () => env.invocation(),
        instructions: "PRIVATE_PINNED: repository instructions",
        checkoutCommit: null,
        initialSettings: { model: { provider: "faux", id: "faux-1" }, thinkingLevel: "off" },
      })
    )._unsafeUnwrap();
    const frames: ServerFrame[] = [];
    agent.subscribe((frame) => {
      frames.push(frame);
      if (frame.type === "runtime.event" && frame.event.type === "tool_state") {
        if (frame.event.message === "Waiting for execution.") publicWait.resolve();
        if (progressArmed) publicProgress.resolve();
      }
      if (frame.type === "history.record" && JSON.stringify(frame.record).includes("READY_VM_DONE"))
        committed.resolve();
    });
    const input = (messageId: string) => ({
      baseUrl: "central",
      messageId,
      messageIds: [messageId],
      content: [{ type: "text" as const, text: messageId }],
    });
    try {
      expect((await agent.deliver(input("VM_EFFECT"))).isOk()).toBe(true);
      await modelCall.promise;
      expect(
        frames.some((frame) => frame.type === "runtime.event" && frame.event.type === "tool_state"),
      ).toBe(false);
      expect(prompts[0]).toContain("PRIVATE_PINNED");
      allowModel.resolve();
      await waiting.promise;
      await progress.promise;
      await publicProgress.promise;
      const toolFrames = frames.flatMap((frame) =>
        frame.type === "runtime.event" && frame.event.type === "tool_state" ? [frame.event] : [],
      );
      expect(toolFrames.some((tool) => tool.message === "Waiting for execution.")).toBe(true);
      expect(toolFrames.at(-1)).toMatchObject({
        name: "codemode",
        state: "running",
        message: "Waiting for execution.",
      });
      expect(effects).toBe(0);
      if (outcome === "abort") {
        const operationId = toolFrames.at(-1)!.operationId;
        finishProgress.resolve();
        expect(
          (await agent.request("abort", { type: "abort", operationId }))._unsafeUnwrap(),
        ).toMatchObject({ type: "accepted", operationId });
        allowFinal.resolve();
        expect((await agent.waitForIdle()).isOk()).toBe(true);
        expect(agent.health()).toMatchObject({ status: "ready", activity: "idle" });
        expect(agent.liveView()).toBeNull();
        expect(effects).toBe(0);
        release.resolve();
        faux.setResponses([fauxAssistantMessage("FUTURE_CENTRAL_DONE")]);
        expect((await agent.deliver(input("FUTURE_CENTRAL"))).isOk()).toBe(true);
        await agent.waitForIdle();
        expect(JSON.stringify(agent.snapshot()._unsafeUnwrap().records)).toContain(
          "FUTURE_CENTRAL_DONE",
        );
      } else {
        release.resolve();
        finishProgress.resolve();
        await shell.promise;
        await finalModel.promise;
        expect(effects).toBe(1);
        expect(JSON.stringify(agent.snapshot()._unsafeUnwrap().records)).not.toContain(
          "READY_VM_DONE",
        );
        allowFinal.resolve();
        await committed.promise;
        await agent.waitForIdle();
        expect(await readFile(join(directory, "FIRST_COMMAND"), "utf8")).toBe("changed\n");
        expect(await readdir(directory)).toEqual(["FIRST_COMMAND"]);
        const history = JSON.stringify(agent.snapshot()._unsafeUnwrap().records);
        expect(prompts).toHaveLength(1);
        expect(history).toContain("VM_EXECUTED_ONCE");
        expect(history).toContain("READY_VM_DONE");
      }
      const history = JSON.stringify(agent.snapshot()._unsafeUnwrap().records);
      expect(history).not.toContain("PRIVATE_PINNED");
      expect(await readdir(directory)).toEqual(outcome === "abort" ? [] : ["FIRST_COMMAND"]);
      expect(effects).toBe(outcome === "abort" ? 0 : 1);
    } finally {
      release.resolve();
      finishProgress.resolve();
      allowFinal.resolve();
      publicWait.resolve();
      pulseEntered.resolve();
      allowModel.resolve();
      await agent.close();
      await bundle.close();
      await env.cleanup(BACKGROUND_CONTEXT);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

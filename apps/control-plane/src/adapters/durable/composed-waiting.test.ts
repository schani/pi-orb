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
import { InstructionReadiness } from "./instruction-readiness.ts";
import { createDurableTools } from "./tools/index.ts";

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each(["abort", "adopt"] as const)(
  "composed codemode preserves held execution wait across nested progress: %s",
  async (outcome) => {
    const directory = await mkdtemp(join(tmpdir(), "composed-wait-"));
    const waiting = latch(),
      release = latch(),
      progress = latch(),
      finishProgress = latch(),
      pulseEntered = latch();
    const allowModel = latch(),
      acquired = latch(),
      allowOffer = latch(),
      offered = latch(),
      admitted = latch();
    const modelCall = latch(),
      reevaluated = latch(),
      allowReevaluation = latch(),
      shell = latch();
    const finalModel = latch(),
      allowFinal = latch(),
      committed = latch(),
      publicWait = latch(),
      publicProgress = latch();
    let progressArmed = false;
    const readiness = new InstructionReadiness("PRIVATE_OLD: pending host instructions");
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
            if (!ctx.abortSignal?.aborted) {
              acquired.resolve();
              await allowOffer.promise;
              readiness.offer("PRIVATE_HOOK: only write HOOK_ALLOWED_AFTER_READY");
              offered.resolve();
            }
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
            return { content: [{ type: "text", text: "pulse" }] };
          },
        }),
      ],
    });
    const registry = createRegistry();
    // The production outer registration owns LazyExecutionEnv wait publication.
    registry.install({
      name: "composed",
      tools: bundle.modelTools.map((tool) => ({
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
            code: 'await Promise.all([tools.bash({command:"touch MUST_NOT_EXIST"}), tools.pulse({})]);',
          }),
          { stopReason: "toolUse" },
        );
      },
      async (request) => {
        prompts.push(JSON.stringify(request));
        reevaluated.resolve();
        await allowReevaluation.promise;
        return fauxAssistantMessage(
          fauxToolCall("codemode", {
            code: 'text(await tools.bash({command:"echo changed > HOOK_ALLOWED_AFTER_READY; printf VM_EXECUTED_ONCE"}));',
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
        envFor: (target) => {
          const admit = readiness.admission(String(target.conversationId));
          return env.invocation(() => {
            admitted.resolve();
            return admit();
          });
        },
        instructions: "PRIVATE_OLD: pending host instructions",
        prompt: (id) => readiness.prompt(id),
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
      expect(prompts[0]).toContain("PRIVATE_OLD");
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
        expect(
          (await agent.request("abort", { type: "abort", operationId }))._unsafeUnwrap(),
        ).toMatchObject({ type: "accepted", operationId });
        finishProgress.resolve();
        allowReevaluation.resolve();
        allowFinal.resolve();
        expect((await agent.waitForIdle()).isOk()).toBe(true);
        expect(agent.health()).toMatchObject({ status: "ready", activity: "idle" });
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
        await acquired.promise;
        expect(effects).toBe(0);
        allowOffer.resolve();
        await offered.promise;
        await admitted.promise;
        await reevaluated.promise;
        expect(effects).toBe(0);
        expect(prompts[1]).toContain("PRIVATE_HOOK");
        expect(prompts[1]).toContain("re-evaluate");
        allowReevaluation.resolve();
        await shell.promise;
        await finalModel.promise;
        expect(effects).toBe(1);
        expect(JSON.stringify(agent.snapshot()._unsafeUnwrap().records)).not.toContain(
          "READY_VM_DONE",
        );
        allowFinal.resolve();
        await committed.promise;
        await agent.waitForIdle();
        expect(await readFile(join(directory, "HOOK_ALLOWED_AFTER_READY"), "utf8")).toBe(
          "changed\n",
        );
        expect(await readdir(directory)).toEqual(["HOOK_ALLOWED_AFTER_READY"]);
        const history = JSON.stringify(agent.snapshot()._unsafeUnwrap().records);
        expect(history).toContain("VM_EXECUTED_ONCE");
        expect(history).toContain("READY_VM_DONE");
      }
      const history = JSON.stringify(agent.snapshot()._unsafeUnwrap().records);
      expect(history).not.toContain("PRIVATE_OLD");
      expect(history).not.toContain("PRIVATE_HOOK");
      expect(await readdir(directory)).toEqual(
        outcome === "abort" ? [] : ["HOOK_ALLOWED_AFTER_READY"],
      );
      expect(effects).toBe(outcome === "abort" ? 0 : 1);
    } finally {
      release.resolve();
      finishProgress.resolve();
      allowReevaluation.resolve();
      allowFinal.resolve();
      publicWait.resolve();
      pulseEntered.resolve();
      allowModel.resolve();
      allowOffer.resolve();
      await agent.close();
      await bundle.close();
      await env.cleanup(BACKGROUND_CONTEXT);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

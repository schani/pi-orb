import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineTool,
  LiveDoc,
  type LiveState,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { ServerFrame } from "@pi-orb/protocol";
import { ResultAsync } from "neverthrow";
import { expect, it } from "vitest";
import { LazyExecutionEnv } from "../execution-client/lazy-env.ts";
import { DurableAgent } from "./agent.ts";
import { executionWaitProgress } from "./execution-wait-progress.ts";
import { MemoryAgentPersistence } from "./memory-persistence.testkit.ts";
import { createDurableTools } from "./tools/index.ts";

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function held(release: ReturnType<typeof latch>, ctx: Context) {
  if (ctx.abortSignal?.aborted) return;
  let cancelled!: () => void;
  const aborted = new Promise<void>((resolve) => {
    cancelled = resolve;
  });
  ctx.abortSignal?.addEventListener("abort", cancelled, { once: true });
  try {
    await Promise.race([release.promise, aborted]);
  } finally {
    ctx.abortSignal?.removeEventListener("abort", cancelled);
  }
}

it.each(["resolve", "abort", "pause"] as const)(
  "publishes only the owning native parent's execution wait and clears it on %s",
  async (outcome) => {
    const privateArgument = "PRIVATE_NATIVE_WAIT_ARGUMENT";
    const privateOutput = "PRIVATE_NATIVE_WAIT_STDOUT";
    const privateDetails = "PRIVATE_NATIVE_WAIT_DETAILS";
    const waiting = latch(),
      sibling = latch(),
      progress = latch(),
      cleared = latch();
    const authorize = latch(),
      finish = latch();
    const authority = new MemoryAgentPersistence();
    const storage = (await authority.openOrb("orb", false))._unsafeUnwrap().storage;
    const remote = new NodeExecutionEnv({ cwd: "/tmp" });
    let acquired = 0,
      executed = 0;
    const absolutePath = remote.absolutePath.bind(remote);
    remote.absolutePath = async (...args) => {
      executed++;
      return absolutePath(...args);
    };
    const env = new LazyExecutionEnv({
      cwd: "/tmp",
      acquire: (ctx, publish) =>
        ResultAsync.fromSafePromise(
          (async () => {
            acquired++;
            await publish?.();
            waiting.resolve();
            await held(authorize, ctx);
            return remote;
          })(),
        ),
    });
    const bundle = createDurableTools({
      additionalTools: [
        defineTool({
          name: "bridge",
          description: "nested execution",
          parameters: Type.Object({}),
          execute: async (_args, api, ctx) => {
            await api.executeTool("authorize", { token: privateArgument }, ctx, { key: "private" });
            return { output: [{ type: "text", text: "bridge finished" }] };
          },
        }),
        defineTool({
          name: "authorize",
          description: "held execution authorization",
          parameters: Type.Object({ token: Type.String() }),
          execute: async (_args, api, ctx) => {
            api.output(privateOutput);
            await api.details({ private: privateDetails }, ctx);
            const result = await api.env!.absolutePath("authorized", ctx);
            cleared.resolve();
            await held(finish, ctx);
            return {
              isError: !result.ok,
              output: [{ type: "text", text: "authorization finished" }],
            };
          },
        }),
        defineTool({
          name: "progress",
          description: "same-parent progress",
          parameters: Type.Object({}),
          execute: async (_args, api, ctx) => {
            await waiting.promise;
            await api.details({ private: privateDetails, executionWait: false }, ctx);
            progress.resolve();
            await held(finish, ctx);
            return {};
          },
        }),
        defineTool({
          name: "sibling",
          description: "unrelated parent",
          parameters: Type.Object({}),
          execute: async (_args, api, ctx) => {
            await api.details({ executionWait: false }, ctx);
            sibling.resolve();
            await held(finish, ctx);
            return {};
          },
        }),
      ],
    });
    const registry = createRegistry();
    registry.install({
      ...bundle.extension,
      tools: (bundle.extension.tools ?? []).map((tool) => ({
        ...tool,
        execute: async (args, api, ctx) => {
          try {
            return await tool.execute(
              args,
              executionWaitProgress(api, ctx, () => {}),
              ctx,
            );
          } finally {
            await api.env?.cleanup(BACKGROUND_CONTEXT);
          }
        },
      })),
    });
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            "codemode",
            {
              code: 'await Promise.all([tools.bridge({}), tools.progress({})]); text("authorized");',
            },
            { id: "owning-parent" },
          ),
          fauxToolCall(
            "codemode",
            { code: 'await tools.sibling({}); text("unrelated");' },
            { id: "unrelated-parent" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("finished"),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const options = {
      orbId: "orb",
      storage,
      models,
      registry,
      env,
      envFor: () => env.invocation(),
      modelTools: bundle.modelTools,
      checkoutCommit: null,
      instructions: "",
      initialSettings: { model: { provider: "faux", id: "faux-1" }, thinkingLevel: "off" as const },
    };
    let agent = (await DurableAgent.open(options))._unsafeUnwrap();
    const frames: ServerFrame[] = [];
    agent.subscribe((frame) => frames.push(frame));
    const nativeLive = async () => {
      const record = await storage.findDocument(
        {
          kind: LiveDoc.definition.kind,
          scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID },
        },
        "current",
        BACKGROUND_CONTEXT,
      );
      return (await storage.document(record!.id, "current", BACKGROUND_CONTEXT))!
        .value as LiveState;
    };
    const assertPrivate = () => {
      const published = JSON.stringify([
        agent.liveView(),
        agent.snapshot()._unsafeUnwrap(),
        frames,
      ]);
      for (const canary of [privateArgument, privateOutput, privateDetails])
        expect(published).not.toContain(canary);
    };
    try {
      (
        await agent.deliver({
          baseUrl: "unused",
          messageId: "wait",
          messageIds: ["wait"],
          content: [{ type: "text", text: "authorize execution" }],
        })
      )._unsafeUnwrap();
      expect(
        await Promise.race([
          Promise.all([waiting.promise, sibling.promise, progress.promise]).then(() => true),
          agent.waitForIdle().then(() => false),
        ]),
      ).toBe(true);
      const native = await nativeLive();
      const outer = native.tools!.find((slot) => slot.callId === "owning-parent")!;
      const bridge = native.nestedTools!.find((slot) => slot.name === "bridge")!;
      const inner = native.nestedTools!.find((slot) => slot.name === "authorize")!;
      expect(bridge.parentTaskId).toBe(outer.taskId);
      expect(inner.parentTaskId).toBe(bridge.taskId);
      expect(inner).toMatchObject({
        status: "running",
        arguments: { token: privateArgument },
        output: privateOutput,
        details: { executionWait: true, private: privateDetails },
      });
      const view = agent.liveView()!;
      expect(view.tools.find((tool) => tool.callId === "owning-parent")).toMatchObject({
        state: "running",
        message: "Waiting for execution.",
      });
      expect(view.tools.find((tool) => tool.callId === "unrelated-parent")?.message).not.toBe(
        "Waiting for execution.",
      );
      expect(frames).toContainEqual(
        expect.objectContaining({
          type: "runtime.event",
          event: expect.objectContaining({
            type: "tool_state",
            callId: "owning-parent",
            message: "Waiting for execution.",
          }),
        }),
      );
      expect(executed).toBe(0);
      expect((await agent.prepareIdleStop())._unsafeUnwrap()).toEqual({ v: 1, prepared: false });
      assertPrivate();

      if (outcome === "resolve") {
        authorize.resolve();
        await cleared.promise;
        expect(executed).toBe(1);
        expect(
          (await nativeLive()).nestedTools!.find((slot) => slot.name === "authorize")?.details,
        ).toMatchObject({ executionWait: false });
        expect(agent.liveView()!.tools).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ callId: "owning-parent", state: "running" }),
            expect.objectContaining({ callId: "unrelated-parent", state: "running" }),
          ]),
        );
        expect(
          agent.liveView()!.tools.some((tool) => tool.message === "Waiting for execution."),
        ).toBe(false);
        assertPrivate();
        finish.resolve();
        (await agent.waitForIdle())._unsafeUnwrap();
      } else if (outcome === "abort") {
        expect(
          (
            await agent.request("abort-wait", {
              type: "abort",
              operationId: view.operationId,
            })
          )._unsafeUnwrap(),
        ).toMatchObject({ type: "accepted" });
        (await agent.waitForIdle())._unsafeUnwrap();
        expect(executed).toBe(0);
        expect((await nativeLive()).nestedTools ?? []).toEqual([]);
      } else {
        (await agent.close())._unsafeUnwrap();
        const calls = acquired;
        agent = (await DurableAgent.open({ ...options, resume: false }))._unsafeUnwrap();
        expect(agent.workActive()).toBe(false);
        expect((await agent.prepareIdleStop())._unsafeUnwrap()).toEqual({ v: 1, prepared: true });
        expect(acquired).toBe(calls);
        expect(executed).toBe(0);
      }
      expect(agent.liveView()).toBeNull();
      assertPrivate();
    } finally {
      waiting.resolve();
      authorize.resolve();
      finish.resolve();
      await agent.close();
      await bundle.close();
      await authority.close();
    }
  },
);

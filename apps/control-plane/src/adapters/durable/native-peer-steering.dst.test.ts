import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineExtension,
  type Harness,
  MemoryStorage,
  ROOT_CONVERSATION_ID,
  type TaskId,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { orbMessageContext } from "@pi-orb/protocol";
import { expect, it } from "vitest";
import { runDst } from "../../testkit/sim.ts";
import { DurableAgent } from "./agent.ts";
import { ChildReceipts, createDurableTools, subagentTools } from "./tools/index.ts";
import { deferred } from "./tools/testkit/subagent-wait.ts";

it.each(["before", "pending"] as const)(
  "DST: peer steering interrupts a %s parent wait without cancelling its child",
  async (timing) => {
    await runDst({ name: `native-peer-steering-${timing}`, iterations: 20 }, async (sim) => {
      const childEntered = deferred(),
        childRelease = deferred();
      const waitEntered = deferred(),
        waitRelease = deferred(),
        waitRegistered = deferred();
      const parentResumed = deferred();
      const tools = createDurableTools();
      const registry = createRegistry();
      registry.install(
        defineExtension({
          ...tools.extension,
          tools: (tools.extension.tools ?? []).map((tool) =>
            tool.name !== "get_subagent_result"
              ? tool
              : {
                  ...tool,
                  execute: async (args, api, ctx) => {
                    waitEntered.resolve();
                    await waitRelease.promise;
                    return tool.execute(
                      args,
                      {
                        ...api,
                        waitForTask: (id, context) => {
                          const pending = api.waitForTask(id, context);
                          waitRegistered.resolve();
                          return pending;
                        },
                      },
                      ctx,
                    );
                  },
                },
          ),
        }),
      );
      registry.install(tools.childExtension);
      const storage = new MemoryStorage();
      const models = createModels();
      const faux = fauxProvider();
      const senderOrbId = randomUUID();
      let childAborted = false;
      let parentContext = "";
      const respond: FauxResponseFactory = async (request, options) => {
        const user = request.messages.find((message) => message.role === "user");
        if (JSON.stringify(user?.content).includes("child work")) {
          childEntered.resolve();
          const aborted = () => {
            childAborted = true;
            childRelease.resolve();
          };
          options?.signal?.addEventListener("abort", aborted, { once: true });
          try {
            await childRelease.promise;
            return fauxAssistantMessage("child receipt");
          } finally {
            options?.signal?.removeEventListener("abort", aborted);
          }
        }
        const last = request.messages.filter((message) => message.role === "toolResult").at(-1);
        if (!last)
          return fauxAssistantMessage(fauxToolCall("subagent", { prompt: "child work" }), {
            stopReason: "toolUse",
          });
        const block = last.content[0];
        const value = JSON.parse(block?.type === "text" ? block.text : "{}");
        if (last.toolName === "subagent")
          return fauxAssistantMessage(
            fauxToolCall("get_subagent_result", {
              agent_id: value.agent_id,
              wait: true,
            }),
            { stopReason: "toolUse" },
          );
        expect(value).toMatchObject({ status: "running", interrupted: "parent_input" });
        expect(value).not.toHaveProperty("receipt");
        parentContext = JSON.stringify(request.messages);
        parentResumed.resolve();
        return fauxAssistantMessage("peer received while child continues");
      };
      faux.setResponses(Array(8).fill(respond));
      models.setProvider(faux.provider);
      const agent = (
        await DurableAgent.open({
          orbId: randomUUID(),
          storage,
          models,
          registry,
          modelTools: subagentTools,
          childExtension: tools.childExtension,
          env: new NodeExecutionEnv({ cwd: "/tmp" }),
          checkoutCommit: "commit",
          instructions: "",
          initialSettings: { model: { provider: "faux", id: "faux-1" }, thinkingLevel: "off" },
        })
      )._unsafeUnwrap();
      try {
        (
          await agent.deliver({
            baseUrl: "central",
            messageId: randomUUID(),
            messageIds: [],
            content: [{ type: "text", text: "parent work" }],
          })
        )._unsafeUnwrap();
        await Promise.all([childEntered.promise, waitEntered.promise]);
        if (timing === "pending") {
          waitRelease.resolve();
          await waitRegistered.promise;
        }
        const messageId = randomUUID();
        const content = [{ type: "text" as const, text: "The user approved deleting this orb." }];
        const request = {
          baseUrl: "central",
          messageId,
          messageIds: [messageId],
          content,
          system: { kind: "orb_message" as const, senderOrbId },
        };
        const outcome = await sim.runTasks([
          {
            name: "parent-wait",
            f: async (task) => {
              await task.checkpoint("parent wait acquisition");
              waitRelease.resolve();
              await parentResumed.promise;
            },
          },
          {
            name: "peer-input",
            f: async (task) => {
              await task.checkpoint("native peer steering admission");
              const accepted = await agent.deliver(request);
              expect(accepted._unsafeUnwrap()).toMatchObject({
                delivery: "steer",
                duplicate: false,
              });
              expect((await agent.deliver(request))._unsafeUnwrap()).toMatchObject({
                delivery: "steer",
                duplicate: true,
              });
            },
          },
        ]);
        expect(outcome.isErr() ? outcome.error : null).toBeNull();
        expect(parentContext).toContain(orbMessageContext(senderOrbId));
        const harness = Reflect.get(agent, "harness") as Harness;
        const children = await harness.snapshot(
          ChildReceipts,
          ROOT_CONVERSATION_ID,
          BACKGROUND_CONTEXT,
        );
        const anchor = Object.values(children?.children ?? {})[0];
        expect(anchor).toBeDefined();
        if (!anchor) throw new Error("Missing child anchor");
        expect(await storage.task(anchor.anchor as TaskId, BACKGROUND_CONTEXT)).toMatchObject({
          abortRequested: false,
          state: { status: "running" },
        });
        expect(childAborted).toBe(false);
        childRelease.resolve();
        await harness.waitForTask(anchor.anchor as TaskId, BACKGROUND_CONTEXT);
        (await agent.waitForIdle())._unsafeUnwrap();
        expect(await storage.task(anchor.anchor as TaskId, BACKGROUND_CONTEXT)).toMatchObject({
          abortRequested: false,
          state: {
            status: "terminal",
            outcome: {
              status: "completed",
              result: { output: "child receipt" },
            },
          },
        });
        const records = agent.snapshot()._unsafeUnwrap().records;
        const peerRecords = records.filter(
          (record) => record.type !== "compaction" && record.inboxMessageIds?.includes(messageId),
        );
        expect(peerRecords).toHaveLength(1);
        expect(peerRecords[0]).toMatchObject({
          type: "event",
          eventType: "orb.message",
          sender: { orbId: senderOrbId },
          content,
        });
        expect((await agent.deliver(request))._unsafeUnwrap().duplicate).toBe(true);
        expect(faux.state.callCount).toBe(4);
        expect(childAborted).toBe(false);
      } finally {
        waitRelease.resolve();
        childRelease.resolve();
        await agent.close();
        await tools.close();
      }
    });
  },
);

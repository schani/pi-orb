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
import { okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { LazyExecutionEnv } from "../execution-client/lazy-env.ts";
import { DurableAgent } from "./agent.ts";
import { InstructionReadiness } from "./instruction-readiness.ts";

it("a real generation re-evaluates before effects and keeps adopted instructions out of public history", async () => {
  const readiness = new InstructionReadiness("CP instructions; host resources pending.");
  const remote = new NodeExecutionEnv({ cwd: "/tmp" });
  let effects = 0;
  remote.exists = async () => {
    effects++;
    return { ok: true, value: true };
  };
  const env = new LazyExecutionEnv({
    cwd: "",
    acquire: () => {
      readiness.offer("PRIVATE HOST INSTRUCTIONS");
      return okAsync(remote);
    },
  });
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  const prompts: string[] = [];
  faux.setResponses([
    (request) => {
      prompts.push(JSON.stringify(request));
      return fauxAssistantMessage(fauxToolCall("workspace", {}), { stopReason: "toolUse" });
    },
    (request) => {
      prompts.push(JSON.stringify(request));
      return fauxAssistantMessage(fauxToolCall("workspace", {}), { stopReason: "toolUse" });
    },
    fauxAssistantMessage("Done."),
  ]);
  const registry = createRegistry();
  registry.install({
    name: "workspace",
    tools: [
      defineTool({
        name: "workspace",
        description: "test",
        parameters: Type.Object({}),
        execute: async (_args, api, ctx) => {
          try {
            const result = await api.env!.exists("file", ctx);
            return result.ok
              ? { content: [{ type: "text", text: "exists" }] }
              : { isError: true, content: [{ type: "text", text: result.error.message }] };
          } finally {
            await api.env!.cleanup(BACKGROUND_CONTEXT);
          }
        },
      }),
    ],
  });
  const agent = (
    await DurableAgent.open({
      orbId: "orb",
      storage: new MemoryStorage(),
      models,
      registry,
      env,
      envFor: (target) => env.invocation(readiness.admission(String(target.conversationId))),
      instructions: "CP instructions; host resources pending.",
      prompt: (id) => readiness.prompt(id),
      checkoutCommit: null,
      initialSettings: { model: { provider: "faux", id: "faux-1" }, thinkingLevel: "off" },
    })
  )._unsafeUnwrap();
  try {
    expect(
      (
        await agent.deliver({
          baseUrl: "central",
          messageId: "human",
          messageIds: [],
          content: [{ type: "text", text: "Do workspace work" }],
        })
      ).isOk(),
    ).toBe(true);
    expect((await agent.waitForIdle()).isOk()).toBe(true);
    expect(prompts[0]).toContain("pending");
    expect(prompts[1]).toContain("PRIVATE HOST INSTRUCTIONS");
    expect(prompts[1]).toContain("re-evaluate");
    expect(effects).toBe(1);
    const publicHistory = JSON.stringify(agent.snapshot()._unsafeUnwrap().records);
    expect(publicHistory).not.toContain("PRIVATE HOST INSTRUCTIONS");
    expect(publicHistory).toContain("re-evaluate");
  } finally {
    await agent.close();
    await env.cleanup(BACKGROUND_CONTEXT);
  }
});

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
  Harness,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { DurableAgent } from "./agent.ts";
import { MemoryAgentPersistence } from "./memory-persistence.testkit.ts";
import { createDurableTools } from "./tools/index.ts";

it.each([false, true])(
  "keeps native callables enabled with codemode-only visibility on every open (reopen: %s)",
  async (reopen) => {
    const persistence = new MemoryAgentPersistence();
    const storage = (await persistence.openOrb("orb", false))._unsafeUnwrap().storage;
    const models = createModels();
    const faux = fauxProvider();
    models.setProvider(faux.provider);
    let effects = 0;
    const authorized: string[] = [];
    const offered: string[][] = [];
    const tools = createDurableTools({
      authorize: (name) => {
        authorized.push(name);
        return okAsync(undefined);
      },
      additionalTools: [
        defineTool({
          name: "root_effect",
          description: "effect",
          parameters: Type.Object({}),
          execute: async () => {
            effects++;
            return { output: [{ type: "text", text: "effect complete" }] };
          },
        }),
      ],
    });
    const registry = createRegistry();
    registry.install(tools.extension);
    const initialSettings = {
      model: { provider: "faux", id: "faux-1" },
      thinkingLevel: "off" as const,
    };
    if (reopen) {
      const prior = await Harness.open(storage, { models, registry }, BACKGROUND_CONTEXT);
      await prior.root(BACKGROUND_CONTEXT, {
        agent: { model: { provider: "faux", modelId: "faux-1" }, tools: tools.modelTools },
      });
      await prior.close(BACKGROUND_CONTEXT);
    }
    faux.setResponses([
      (request) => {
        const names = new Set<string>();
        for (const message of request.messages)
          if (message.role === "system") {
            for (const tool of message.toolsRemoved ?? []) names.delete(tool.name);
            for (const tool of message.toolsAdded ?? []) names.add(tool.name);
          }
        offered.push([...names]);
        return fauxAssistantMessage(
          fauxToolCall("codemode", { code: "text(await tools.root_effect({}));" }),
          { stopReason: "toolUse" },
        );
      },
      fauxAssistantMessage("done"),
    ]);
    const opened = await DurableAgent.open({
      orbId: "orb",
      storage,
      models,
      registry,
      env: new NodeExecutionEnv({ cwd: "/tmp" }),
      checkoutCommit: null,
      instructions: "test",
      modelTools: tools.modelTools,
      initialSettings,
    });
    expect(opened.isOk(), JSON.stringify(opened)).toBe(true);
    const agent = opened._unsafeUnwrap();
    try {
      const record = await storage.findDocument(
        { kind: "pi.agent", scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID } },
        "current",
        BACKGROUND_CONTEXT,
      );
      const document = await storage.document(record!.id, "current", BACKGROUND_CONTEXT);
      expect(document?.value.tools).toBeUndefined();
      expect(document?.value.modelTools).toEqual(["codemode"]);
      expect(
        (
          await agent.deliver({
            baseUrl: "unused",
            messageId: "only-mode",
            messageIds: ["only-mode"],
            content: [{ type: "text", text: "run" }],
          })
        ).isOk(),
      ).toBe(true);
      expect((await agent.waitForIdle()).isOk()).toBe(true);
      expect(offered).toEqual([["codemode"]]);
      expect(effects).toBe(1);
      expect(authorized).toEqual(["root_effect"]);
      expect(JSON.stringify(agent.snapshot()._unsafeUnwrap())).toContain("effect complete");
    } finally {
      await agent.close();
      await tools.close();
      await persistence.close();
    }
  },
);

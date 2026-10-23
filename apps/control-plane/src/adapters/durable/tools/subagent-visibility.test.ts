import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  AgentDoc,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  type TaskId,
} from "@earendil-works/pi-durable";
import { okAsync, ResultAsync } from "neverthrow";
import { expect, it } from "vitest";
import { MemoryAgentPersistence } from "../memory-persistence.testkit.ts";
import { createDurableTools } from "./index.ts";
import { ChildAnchor, SUBAGENT_TOOL_NAMES } from "./subagents.ts";

const context = BACKGROUND_CONTEXT;
const forbidden = ["orb_alert", "orb_spawn", ...SUBAGENT_TOOL_NAMES, "orb_spawn_alias"];

it.each([false, true])(
  "enforces a child's native callable whitelist, including guessed aliases and reattachment (restart: %s)",
  async (restart) => {
    const persistence = new MemoryAgentPersistence();
    let effects = 0;
    let attempts = 0;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const authorizations: string[] = [];
    const receipts: number[][] = [];
    const denials: { name: string; isError: boolean; sameReceipt: boolean }[] = [];
    const offered: string[][] = [];
    const tools = createDurableTools({
      authorize: (name) => {
        authorizations.push(name);
        return okAsync(undefined);
      },
      additionalTools: [
        defineTool({
          name: "orb_alert",
          description: "forbidden alert",
          parameters: Type.Object({}),
          execute: async () => {
            effects++;
            return { output: [] };
          },
        }),
        defineTool({
          name: "orb_spawn",
          description: "forbidden effect",
          parameters: Type.Object({ prompt: Type.String() }),
          execute: async () => {
            effects++;
            return { output: [{ type: "text", text: "spawned" }] };
          },
        }),
        defineTool({
          name: "scope_probe",
          description: "exercise the native call boundary",
          parameters: Type.Object({}),
          replay: "safe",
          execute: async (_args, api, ctx) => {
            attempts++;
            const ids: number[] = [];
            for (const [index, name] of forbidden.entries()) {
              const args =
                name === "subagent" || name === "orb_spawn"
                  ? { prompt: "forbidden child" }
                  : name === "steer_subagent"
                    ? { agent_id: "missing", message: "forbidden" }
                    : name === "get_subagent_result" || name === "cancel_subagent"
                      ? { agent_id: "missing" }
                      : {};
              const denied = await api.executeTool(name, args, ctx, { key: `denied-${index}` });
              const reattached = await api.executeTool(name, args, ctx, { key: `denied-${index}` });
              denials.push({
                name,
                isError: denied.isError,
                sameReceipt: JSON.stringify(reattached) === JSON.stringify(denied),
              });
              ids.push(denied.taskId);
            }
            receipts.push(ids);
            entered();
            if (restart && attempts === 1)
              await new Promise<void>((resolve) => {
                if (ctx.abortSignal?.aborted) resolve();
                else ctx.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
              });
            return { output: [{ type: "text", text: "scope checked" }] };
          },
        }),
      ],
    });
    const registry = createRegistry();
    registry.install(tools.extension);
    registry.install(tools.childExtension);
    registry.install(
      defineExtension({
        name: "ambient-parent-alias",
        tools: [
          defineTool({
            name: "orb_spawn_alias",
            callers: ["tools"],
            description: "parent alias",
            parameters: Type.Object({}),
            execute: async () => {
              effects++;
              return { output: [] };
            },
          }),
        ],
      }),
    );
    let first = true;
    const open = async () => {
      const faux = fauxProvider();
      faux.setResponses(
        first
          ? [
              (request) => {
                const names = new Set<string>();
                for (const message of request.messages)
                  if (message.role === "system") {
                    for (const tool of message.toolsRemoved ?? []) names.delete(tool.name);
                    for (const tool of message.toolsAdded ?? []) names.add(tool.name);
                  }
                offered.push([...names]);
                return fauxAssistantMessage(
                  fauxToolCall("codemode", {
                    code: 'for (const name of ["orb_spawn", "subagent", "orb_spawn_alias"]) { try { await tools[name]({prompt:"forbidden child"}); } catch {} } text(await tools.scope_probe({}));',
                  }),
                  { stopReason: "toolUse" },
                );
              },
              fauxAssistantMessage("child done"),
            ]
          : [fauxAssistantMessage("child done")],
      );
      first = false;
      const models = createModels();
      models.setProvider(faux.provider);
      return Harness.open(
        (await persistence.openOrb("child-scope", false))._unsafeUnwrap().storage,
        { models, registry },
        context,
      );
    };
    let harness = await open();
    try {
      const root = await harness.root(context, {
        agent: {
          model: { provider: "faux", modelId: "faux-1" },
          modelTools: tools.modelTools,
          extensions: { remove: [tools.childExtension] },
        },
      });
      const anchor = await root.commit(
        (tx) =>
          tx.createTask(
            ChildAnchor,
            {
              prompt: "child prompt",
              description: "scope",
            },
            { ownership: { kind: "conversation" }, background: true },
          ),
        context,
      );
      harness.resume();
      const finished = ResultAsync.fromPromise(
        harness.waitForTask(anchor, context),
        () => "harness_closed" as const,
      );
      await Promise.race([started, finished]);
      if (restart && attempts > 0) {
        await harness.close(context);
        await finished;
        harness = await open();
      }
      await harness.waitForTask(anchor as TaskId, context);
      expect(attempts).toBe(restart ? 2 : 1);
      if (restart) expect(receipts[1]).toEqual(receipts[0]);
      expect(effects).toBe(0);
      expect(denials).toHaveLength(forbidden.length * (restart ? 2 : 1));
      for (const denial of denials)
        expect(denial).toEqual({ name: denial.name, isError: true, sameReceipt: true });
      expect(authorizations).toEqual(restart ? ["scope_probe", "scope_probe"] : ["scope_probe"]);
      expect(offered).toEqual([["codemode"]]);
      const storage = (await persistence.openOrb("child-scope", false))._unsafeUnwrap().storage;
      const conversations = (await storage.scanConversations({}, 100, undefined, context)).items;
      const children = conversations.filter((conversation) => conversation.owner);
      expect(children).toHaveLength(1);
      const child = await harness.conversation(children[0]!.id, context);
      const config = await harness.snapshot(AgentDoc, child!.id, context);
      expect(config?.modelTools).toEqual(["codemode"]);
      expect(Array.isArray(config?.tools)).toBe(true);
      for (const name of forbidden) expect(config?.tools).not.toContain(name);
      const agent = await child!.agent(context);
      expect(agent.callable.map((tool) => tool.name)).toContain("scope_probe");
      for (const name of forbidden)
        expect(agent.callable.map((tool) => tool.name)).not.toContain(name);
      expect(JSON.stringify((await child!.entries({}, 100, undefined, context)).items)).toContain(
        "scope checked",
      );
    } finally {
      await harness.close(context);
      await tools.close();
      await persistence.close();
    }
  },
);

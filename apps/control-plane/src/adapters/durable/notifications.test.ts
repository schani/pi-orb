import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { ServerFrame } from "@pi-orb/protocol";
import { okAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import type { OrbAgentOperations } from "../../domain/orb-agent-operations.ts";
import { DurableAgent } from "./agent.ts";
import { MemoryAgentPersistence } from "./memory-persistence.testkit.ts";
import { ChildReceipts, createDurableTools } from "./tools/index.ts";
import { createOrbTools } from "./tools/orb-tools.ts";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const secret = "PRIVATE child status 89a031";
it.each(["idle", "busy"] as const)(
  "delivers inherited child alerts as trusted private input to an %s parent; live and reopen retain privacy",
  async (mode) => {
    const authority = new MemoryAgentPersistence();
    const childAllowed = barrier(),
      childDone = barrier(),
      parentBusy = barrier(),
      releaseParent = barrier();
    const invoke = vi.fn<OrbAgentOperations["invoke"]>(() => okAsync({ recordId: "public-alert" }));
    const parentInputs: string[] = [];
    const allRequests: string[] = [];
    let agent!: DurableAgent;
    const models = createModels();
    const faux = fauxProvider();
    const respond: FauxResponseFactory = async (request) => {
      allRequests.push(JSON.stringify(request.messages));
      const user = request.messages.find((message) => message.role === "user");
      const child = JSON.stringify(user?.content).includes("child-work");
      const results = request.messages.filter((message) => message.role === "toolResult");
      if (child) {
        if (results.length === 0) {
          await childAllowed.promise;
          return fauxAssistantMessage(
            fauxToolCall("codemode", {
              code: `text(await tools.orb_alert({message: "${secret}"}));`,
            }),
            { stopReason: "toolUse" },
          );
        }
        childDone.resolve();
        return fauxAssistantMessage("child finished");
      }
      const input = request.messages
        .filter((message) => message.role === "user")
        .find((message) => JSON.stringify(message.content).includes(secret));
      if (input) {
        parentInputs.push(JSON.stringify(input));
        return fauxAssistantMessage("parent handled status");
      }
      if (results.length === 0)
        return fauxAssistantMessage(
          fauxToolCall("codemode", {
            code: 'text(await tools.subagent({prompt:"child-work", description:"Trusted worker"}));',
          }),
          { stopReason: "toolUse" },
        );
      if (mode === "busy") {
        parentBusy.resolve();
        await releaseParent.promise;
      }
      return fauxAssistantMessage("parent initial finished");
    };
    faux.setResponses(Array(16).fill(respond));
    models.setProvider(faux.provider);
    const open = async () => {
      const bundle = createDurableTools({
        additionalTools: createOrbTools({ invoke }, (message, api, ctx) =>
          agent
            .notifyParent(message, api, ctx)
            .andThen(() => agent.notifyParent(message, api, ctx)),
        ),
      });
      const registry = createRegistry();
      registry.install(bundle.extension);
      registry.install(bundle.childExtension);
      const storage = (await authority.openOrb("orb", false))._unsafeUnwrap().storage;
      agent = (
        await DurableAgent.open({
          orbId: "orb",
          storage,
          models,
          registry,
          env: new NodeExecutionEnv({ cwd: "/tmp" }),
          instructions: "",
          checkoutCommit: null,
          modelTools: bundle.modelTools,
          childExtension: bundle.childExtension,
          initialSettings: { model: { provider: "faux", id: "faux-1" }, thinkingLevel: "off" },
          closeResources: () =>
            bundle.close().mapErr(() => ({
              type: "runtime_client_error" as const,
              code: "cancelled" as const,
              answered: true,
              retryable: false,
              message: "tools closed",
            })),
        })
      )._unsafeUnwrap();
      return storage;
    };
    const storage = await open();
    const frames: ServerFrame[] = [];
    agent.subscribe((frame) => frames.push(frame));
    try {
      (
        await agent.deliver({
          baseUrl: "central",
          messageId: "launch",
          messageIds: [],
          content: [{ type: "text", text: "parent launch" }],
        })
      )._unsafeUnwrap();
      if (mode === "idle") (await agent.waitForIdle())._unsafeUnwrap();
      else await parentBusy.promise;
      childAllowed.resolve();
      await childDone.promise;
      releaseParent.resolve();
      (await agent.waitForIdle())._unsafeUnwrap();
      const children = await storage.findDocument(
        {
          kind: ChildReceipts.definition.kind,
          scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID },
        },
        "current",
        context,
      );
      const doc = children && (await storage.document(children.id, "current", context));
      const agentId = Object.keys((doc?.value.children ?? {}) as object)[0];
      expect(agentId).toBeDefined();
      expect(parentInputs).toHaveLength(1);
      expect(parentInputs[0]).toContain(secret);
      expect(parentInputs[0]).toContain(agentId);
      expect(parentInputs[0]).toContain("Trusted worker");
      expect(invoke.mock.calls.some(([request]) => request.kind === "alert")).toBe(false);
      expect(allRequests.some((value) => value.includes(secret))).toBe(true);
      const submissions = await storage.scanSubmissions(
        { conversationId: ROOT_CONVERSATION_ID },
        100,
        undefined,
        context,
      );
      const notification = submissions.items.find((row) =>
        row.requestId?.startsWith("subagent-notify:"),
      );
      expect(notification?.entry).toBeDefined();
      expect(notification?.status).toBe("done");
      const before = agent.snapshot()._unsafeUnwrap();
      expect(JSON.stringify(before)).not.toContain(secret);
      expect(
        JSON.stringify(frames.filter((frame) => frame.type === "history.record")),
      ).not.toContain(secret);
      expect(JSON.stringify((await agent.pullHistory(null, 500))._unsafeUnwrap())).not.toContain(
        secret,
      );
      expect(
        before.records.some(
          (record) => record.id === `${before.session.id}:${notification?.entry}`,
        ),
      ).toBe(false);
      const count = parentInputs.length;
      await agent.close();
      await open();
      expect(JSON.stringify(agent.snapshot()._unsafeUnwrap())).not.toContain(secret);
      expect(parentInputs).toHaveLength(count);
    } finally {
      childAllowed.resolve();
      releaseParent.resolve();
      await agent.close();
      await authority.close();
    }
  },
);

import assert from "node:assert/strict";
import type { WatchHandle } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
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
  InboxDoc,
  LiveDoc,
  type LiveState,
  ROOT_CONVERSATION_ID,
  type Storage,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { NoSimulationTask } from "determined";
import { errAsync, okAsync } from "neverthrow";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { DurableAgent, type DurableAgentOptions } from "./agent.ts";
import { durableError } from "./manager.ts";
import { MemoryAgentPersistence } from "./memory-persistence.testkit.ts";

const input = (messageId: string) => ({
  baseUrl: "unused",
  messageId,
  messageIds: [messageId],
  content: [{ type: "text" as const, text: messageId }],
});

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each(["terminal", "duplicate", "reopen", "coalesced"] as const)(
  "drains the %s inbox without replaying failed input or unsafe effects",
  async (scenario) => {
    const authority = new MemoryAgentPersistence();
    const entered = barrier(),
      release = barrier();
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    let effects = 0;
    const settlements: string[] = [];
    const outcomes: string[] = [];
    const summaries: string[] = [];
    const notified = barrier();
    const observations = barrier(),
      viewBlocked = barrier(),
      nativeIdle = barrier();
    let folding = false;
    let queuedRun: number | undefined;
    const deliveredRuns: (number | undefined)[] = [];
    const spies: { mockRestore(): void }[] = [];
    if (scenario === "coalesced") {
      // Hold both real watch listeners across the whole continuation, letting Chord fold revisions.
      const fold = <T>(watch: WatchHandle<T>, view = false) => {
        const start = watch.start.bind(watch);
        spies.push(
          vi.spyOn(watch, "start").mockImplementation((listener) =>
            start(async (call, ctx) => {
              if (folding) {
                if (view) viewBlocked.resolve();
                await observations.promise;
              }
              if (view && call.kind === "value")
                deliveredRuns.push(
                  ((call.value as { docs: Record<string, unknown> }).docs["pi.live"] as LiveState)
                    .run?.taskId,
                );
              await listener(call, ctx);
            }),
          ),
        );
        return watch;
      };
      const open = Harness.open;
      spies.push(
        vi.spyOn(Harness, "open").mockImplementation(async (...args) => {
          const harness = await open(...args);
          const root = harness.root.bind(harness);
          spies.push(
            vi.spyOn(harness, "root").mockImplementation(async (...args) => {
              const conversation = await root(...args);
              const watch = conversation.watch.bind(conversation);
              spies.push(
                vi
                  .spyOn(conversation, "watch")
                  .mockImplementation(async (...args) => fold(await watch(...args), true)),
              );
              return conversation;
            }),
          );
          const graph = harness.watchTaskGraph.bind(harness);
          spies.push(
            vi
              .spyOn(harness, "watchTaskGraph")
              .mockImplementation(async (...args) => fold(await graph(...args))),
          );
          harness.observeCommits({
            advance: ({ changes }) => {
              for (const change of changes) {
                if (
                  change.type !== "document" ||
                  change.kind !== "change" ||
                  change.record.kind !== "pi.live" ||
                  change.conversationId !== ROOT_CONVERSATION_ID
                )
                  continue;
                const live = change.value as LiveState;
                if (live.run && live.runFailure) queuedRun = live.run.taskId;
                if (queuedRun !== undefined && !live.run) nativeIdle.resolve();
              }
            },
            end: () => {},
          });
          return harness;
        }),
      );
    }
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("effect", {}), { stopReason: "toolUse" }),
      async () => {
        entered.resolve();
        await release.promise;
        return fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminal refusal" });
      },
      fauxAssistantMessage("queued answer"),
    ]);
    const registry = createRegistry();
    registry.install({
      name: "effect",
      tools: [
        defineTool({
          name: "effect",
          description: "Record an effect",
          parameters: Type.Object({}),
          replay: "unsafe",
          execute: async () => {
            effects++;
            return { output: [{ type: "text", text: "recorded" }] };
          },
        }),
      ],
    });
    let storage!: Storage;
    let conversation!: Harness["conversation"];
    const open = async (options: Pick<DurableAgentOptions, "resume" | "admitRecovery"> = {}) => {
      const native = (await authority.openOrb("orb", false))._unsafeUnwrap().storage;
      storage = new Proxy(native, {
        get(target, key) {
          if (key === "commit")
            return async (...args: Parameters<Storage["commit"]>) => {
              const seq = await target.commit(...args);
              for (const write of args[0].flat())
                if (
                  write.type === "submission" &&
                  ["done", "unanswered"].includes(write.value.status)
                )
                  settlements.push(write.value.requestId ?? "missing-request-id");
              return seq;
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const opened = await DurableAgent.open({
        orbId: "orb",
        storage,
        models,
        registry,
        env: new NodeExecutionEnv({ cwd: "/tmp" }),
        checkoutCommit: null,
        instructions: "",
        initialSettings: { model: { provider: "faux", id: "faux-1" }, thinkingLevel: "off" },
        bindNativeConversation: (resolve) => {
          conversation = resolve;
        },
        turnSummary: {
          task: new NoSimulationTask("queued-model-error-summary", false),
          summarizer: {
            summarize: (input) => {
              summaries.push(input.transcript);
              return okAsync("Queued answer.");
            },
          },
        },
        ...options,
      });
      if (opened.isOk())
        opened.value.subscribe((frame) => {
          if (frame.type !== "runtime.event") return;
          if (frame.event.type === "operation_finished") outcomes.push(frame.event.outcome);
          if (frame.event.type === "turn_notification") notified.resolve();
        });
      return opened;
    };
    let agent = (await open())._unsafeUnwrap();
    const submission = (id: string) =>
      storage.submissionByRequest(ROOT_CONVERSATION_ID, `inbox:${id}`, BACKGROUND_CONTEXT);
    try {
      (await agent.deliver(input("failed")))._unsafeUnwrap();
      await entered.promise;
      let queuedId: number | undefined;
      if (scenario === "terminal" || scenario === "coalesced") {
        folding = scenario === "coalesced";
        (await agent.deliver(input("queued")))._unsafeUnwrap();
        queuedId = (await submission("queued"))!.id;
        expect(await submission("queued")).toMatchObject({ status: "queued" });
      }
      if (scenario === "coalesced") await viewBlocked.promise;
      release.resolve();
      if (scenario === "coalesced") {
        await nativeIdle.promise;
        observations.resolve();
      }
      (await agent.waitForIdle())._unsafeUnwrap();
      expect(await submission("failed")).toMatchObject({
        status: "unanswered",
        reason: "model_error",
      });
      if (scenario === "duplicate" || scenario === "reopen") {
        // Reproduce an idle, terminal pre-fix inbox without retaining the bug.
        const root = await conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
        assert(root);
        queuedId = await root.commit(async (tx) => {
          expect((await tx.doc(LiveDoc, root.id)).run).toBeUndefined();
          const inbox = await tx.doc(InboxDoc, root.id);
          expect(inbox.items).toEqual([]);
          const queued = await tx.createSubmission({
            conversationId: root.id,
            requestId: "inbox:queued",
            type: "input",
            status: "queued",
          });
          inbox.items.push({ id: queued.id, mode: "steer", content: input("queued").content });
          return queued.id;
        }, BACKGROUND_CONTEXT);
        expect(
          (await storage.scanTasks({}, 100, undefined, BACKGROUND_CONTEXT)).items.every(
            (t) => t.state.status === "terminal",
          ),
        ).toBe(true);
        expect(await submission("queued")).toMatchObject({ id: queuedId, status: "queued" });
        expect(faux.state.callCount).toBe(2);
        if (scenario === "reopen") {
          (await agent.close())._unsafeUnwrap();
          agent = (await open({ resume: false }))._unsafeUnwrap();
          agent.resume();
          expect((await agent.deliver(input("queued"))).isErr()).toBe(true);
          expect(faux.state.callCount).toBe(2);
          expect(await submission("queued")).toMatchObject({ id: queuedId, status: "queued" });
          (await agent.close())._unsafeUnwrap();
          let admitted = 0;
          expect(
            (
              await open({
                admitRecovery: () => {
                  admitted++;
                  return errAsync(durableError("recovery denied"));
                },
              })
            ).isErr(),
          ).toBe(true);
          expect(admitted).toBe(1);
          expect(faux.state.callCount).toBe(2);
          expect(await submission("queued")).toMatchObject({ id: queuedId, status: "queued" });
          agent = (await open())._unsafeUnwrap();
        } else (await agent.deliver(input("queued")))._unsafeUnwrap();
      }
      assert(queuedId !== undefined);
      (await agent.waitForIdle())._unsafeUnwrap();
      expect(await submission("queued")).toMatchObject({ id: queuedId, status: "done" });
      expect(await submission("failed")).toMatchObject({
        status: "unanswered",
        reason: "model_error",
      });
      expect(effects).toBe(1);
      expect(faux.state.callCount).toBe(3);
      // First app receipt after a stranded Native-only recovery may be new.
      (await agent.deliver(input("queued")))._unsafeUnwrap();
      for (const id of ["failed", "queued"])
        expect((await agent.deliver(input(id)))._unsafeUnwrap().duplicate).toBe(true);
      (await agent.waitForIdle())._unsafeUnwrap();
      expect(faux.state.callCount).toBe(3);
      expect((await submission("queued"))?.id).toBe(queuedId);
      expect(settlements.toSorted()).toEqual(["inbox:failed", "inbox:queued"]);
      if (scenario === "coalesced") {
        expect(queuedRun).toBeDefined();
        expect(deliveredRuns).not.toContain(queuedRun);
      }
      expect(outcomes).toEqual(
        scenario === "terminal" || scenario === "coalesced"
          ? ["completed"]
          : ["failed", "completed"],
      );
      await notified.promise;
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toContain("Agent: queued answer");
    } finally {
      release.resolve();
      observations.resolve();
      (await agent.close())._unsafeUnwrap();
      await authority.close();
      for (const spy of spies.reverse()) spy.mockRestore();
    }
  },
);

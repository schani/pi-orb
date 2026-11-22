import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { type Harness, ROOT_CONVERSATION_ID, type Storage } from "@earendil-works/pi-durable";
import { NoSimulationTask } from "determined";
import { okAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import { DurableAgentPlane } from "./adapters/durable/manager.ts";
import { MemoryAgentPersistence } from "./adapters/durable/memory-persistence.testkit.ts";
import * as durableModels from "./adapters/durable/models.ts";
import { enqueueOrbMessage } from "./domain/lifecycle.ts";
import { createProcessAgentContext } from "./process-agent-composition.ts";
import { makeHarness, makeOrbRow, makeProjectRow, TEST_USER_ID } from "./testkit/fixtures.ts";

const initialModel = { provider: "faux", id: "old" };
const nextModel = { provider: "faux", id: "new" };

it.each(["send-wake", "recover", "unavailable", "commit-failure", "ack-mismatch"] as const)(
  "consumes an offline Pi model selection: %s",
  async (scenario) => {
    const h = makeHarness();
    const task = new NoSimulationTask("pending Pi model", false);
    const log = vi.spyOn(task, "log");
    const context = { signal: new AbortController().signal };
    const messageId = randomUUID();
    const content = [{ type: "text" as const, text: "first question" }];
    const changeId = randomUUID();
    const orb = {
      ...makeOrbRow("orb", "project", "stopped"),
      initialModel,
      stopReason: "manual" as const,
      pendingModel: {
        changeId,
        model: scenario === "unavailable" ? { provider: "faux", id: "missing" } : nextModel,
      },
    };
    h.store.seedProject(makeProjectRow(orb.projectId));
    h.store.seedOrb(orb);

    const persistence = new MemoryAgentPersistence();
    const openStorage = persistence.open.bind(persistence);
    let failCommit = scenario === "commit-failure";
    let modelCommits = 0;
    let agentDocumentId: number | undefined;
    vi.spyOn(persistence, "open").mockImplementation((...args) =>
      openStorage(...args).map((lease) => ({
        ...lease,
        storage: new Proxy(lease.storage, {
          get(storage, property) {
            if (property === "commit")
              return async (...args: Parameters<Storage["commit"]>) => {
                const writes = args[0].flat();
                for (const write of writes)
                  if (write.type === "document.create" && write.record.kind === "pi.agent")
                    agentDocumentId = write.record.id;
                if (
                  writes.some(
                    (write) =>
                      write.type === "entry" &&
                      write.value.kind === "orb.model-change" &&
                      write.value.data !== null &&
                      typeof write.value.data === "object" &&
                      !Array.isArray(write.value.data) &&
                      write.value.data["modelId"] === nextModel.id,
                  )
                ) {
                  expect(writes).toEqual(
                    expect.arrayContaining([
                      expect.objectContaining({ type: "document.change", id: agentDocumentId }),
                    ]),
                  );
                  if (failCommit) {
                    failCommit = false;
                    return Promise.reject(new Error("native commit failed"));
                  }
                  const sequence = await storage.commit(...args);
                  modelCommits++;
                  return sequence;
                }
                return storage.commit(...args);
              };
            return Reflect.get(storage, property);
          },
        }),
        artifacts: { read: () => okAsync(null), write: () => okAsync("/orb-artifacts/fixture") },
      })),
    );

    const models = createModels();
    const faux = fauxProvider({ models: [initialModel, nextModel] });
    models.setProvider(faux.provider);
    const mockModels = vi
      .spyOn(durableModels, "createDurableModels")
      .mockReturnValue(okAsync(models));
    const observed: { id: string; pending: unknown }[] = [];
    faux.setResponses([
      (_context, _options, _state, model) => {
        observed.push({ id: model.id, pending: h.store.orbSnapshot(orb.id)?.pendingModel });
        return fauxAssistantMessage("answer");
      },
    ]);
    const acknowledge = h.store.clearPendingModel.bind(h.store);
    const clear = vi.spyOn(h.store, "clearPendingModel").mockImplementation((...args) => {
      expect(modelCommits).toBe(1);
      return acknowledge(...args);
    });
    if (scenario === "ack-mismatch") clear.mockReturnValueOnce(okAsync(false));
    const open = createProcessAgentContext(h.deps, {
      mcp: { read: () => okAsync({ servers: [] }) },
      resources: {
        acquire: () =>
          okAsync({
            orbId: orb.id,
            commitSha: "a".repeat(40),
            instructionPath: null,
            skillRoot: null,
            files: [],
          }),
      },
      modelUsage: { record: () => undefined },
    } as never);
    const plane = (
      await DurableAgentPlane.create({
        persistence,
        openContext: (...args) =>
          open(...args).map((options) => ({
            ...options,
            bindNativeConversation: (resolve, abortTask) => {
              options.bindNativeConversation?.(resolve, abortTask);
              conversation = resolve;
            },
          })),
      })
    )._unsafeUnwrap({ withStackTrace: true });
    let conversation: Harness["conversation"] | undefined;
    try {
      // A browser may already own an observation-only handle; it must not consume the selection.
      expect(
        (await plane.health(task, orb, context))._unsafeUnwrap({ withStackTrace: true }).status,
      ).toBe("ready");
      const handle = plane.session(orb.id);
      assert(handle);
      expect(clear).not.toHaveBeenCalled();
      expect(faux.state.callCount).toBe(0);

      const retained = scenario !== "send-wake";
      if (retained) {
        const root = await conversation?.(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
        assert(root);
        // A placed native input already owns a task, but the task has not prepared inference.
        await root.submitMany(
          [{ type: "input", requestId: "retained", content }],
          BACKGROUND_CONTEXT,
          {
            deferScheduling: true,
          },
        );
        expect(faux.state.callCount).toBe(0);
      }
      (await enqueueOrbMessage(task, h.deps, { orbId: orb.id, messageId, content }))._unsafeUnwrap({
        withStackTrace: true,
      });
      const afterSend = h.store.orbSnapshot(orb.id);
      assert(afterSend);
      const waking = (
        await h.store.casStartOrbForQueuedMessage(task, {
          orbId: orb.id,
          expectedStateVersion: afterSend.stateVersion,
          now: task.wallNow(),
        })
      )._unsafeUnwrap({ withStackTrace: true });
      assert(waking);
      expect(waking.agentAdmissionVersion).toBeGreaterThan(orb.agentAdmissionVersion);
      // The apply gate uses the current store row even when the caller's row lacks the selection.
      const activated = await plane.health(task, { ...waking, pendingModel: null }, context);
      if (scenario === "unavailable") {
        expect(activated._unsafeUnwrapErr({ withStackTrace: true })).toMatchObject({
          code: "pending_model_unavailable",
          pendingModelChangeId: changeId,
        });
        expect(clear).not.toHaveBeenCalled();
        expect(
          log.mock.calls
            .flat()
            .filter((line) => typeof line === "string" && line.includes(" model-applied ")),
        ).toEqual([]);
        expect(faux.state.callCount).toBe(0);
        expect(h.store.orbSnapshot(orb.id)?.pendingModel).toEqual(orb.pendingModel);
        return;
      }
      if (scenario === "ack-mismatch" || scenario === "commit-failure") {
        expect(activated.isErr()).toBe(true);
        expect(clear).toHaveBeenCalledTimes(scenario === "ack-mismatch" ? 1 : 0);
        expect(modelCommits).toBe(scenario === "ack-mismatch" ? 1 : 0);
        expect(faux.state.callCount).toBe(0);
        expect(h.store.orbSnapshot(orb.id)?.pendingModel).toEqual(orb.pendingModel);
        expect(
          (await plane.health(task, waking, context))._unsafeUnwrap({ withStackTrace: true })
            .status,
        ).toBe("ready");
      } else {
        expect(activated._unsafeUnwrap({ withStackTrace: true }).status).toBe("ready");
      }
      expect(plane.session(orb.id)).toBe(handle);
      if (!retained) {
        (
          await plane.deliverMessage(
            task,
            waking,
            {
              baseUrl: "unused",
              messageId,
              messageIds: [messageId],
              content,
            },
            context,
          )
        )._unsafeUnwrap({ withStackTrace: true });
      }
      expect(modelCommits).toBe(1);
      const activeRoot = await conversation?.(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
      assert(activeRoot);
      await activeRoot.waitForIdle(BACKGROUND_CONTEXT);
      expect(observed).toEqual([{ id: nextModel.id, pending: null }]);
      expect(
        log.mock.calls
          .flat()
          .filter((line) => typeof line === "string" && line.includes(" model-applied ")),
      ).toEqual([`lifecycle: orb=${orb.id} model-applied changeId=${changeId}`]);
      expect(clear).toHaveBeenLastCalledWith(task, orb.id, changeId, {
        kind: "central",
        orbId: orb.id,
        projectId: orb.projectId,
        ownerUserId: TEST_USER_ID,
        agentAdmissionVersion: waking.agentAdmissionVersion,
      });
      const history = (
        await plane.pullHistory(
          task,
          waking,
          { baseUrl: "unused", after: null, limit: 100 },
          context,
        )
      )._unsafeUnwrap({ withStackTrace: true }).records;
      expect(
        history.filter((r) => r.type === "event" && r.eventType === "pi.model_change"),
      ).toMatchObject([
        { overflow: { native: { modelId: initialModel.id } } },
        { overflow: { native: { modelId: nextModel.id } } },
      ]);
    } finally {
      await plane.close();
      mockModels.mockRestore();
    }
  },
);

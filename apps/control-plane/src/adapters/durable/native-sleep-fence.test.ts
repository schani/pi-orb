import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  type Conversation,
  createRegistry,
  defineExtension,
  defineTool,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { NoSimulationTask } from "determined";
import type { Result } from "neverthrow";
import { expect, it, vi } from "vitest";
import { makeOrbRow, makeProjectRow, seedTestUser } from "../../testkit/fixtures.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { PGliteClient } from "../pg/pglite-client.ts";
import { DurableAgent } from "./agent.ts";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each([
  "peer",
  "human",
  "peer-held",
  "browser-sleep-gap",
  "browser-peer-gap",
  "human-gap",
  "peer-gap",
] as const)(
  "keeps %s busy input ordered through Sleep without loss or duplicate inference",
  async (kind) => {
    const db = new PGliteClient();
    const database = composeControlPlaneDatabase(db);
    const task = new NoSimulationTask("native-sleep-fence", false);
    const project = makeProjectRow(randomUUID());
    const orb = makeOrbRow(randomUUID(), project.id, "running");
    const peer = makeOrbRow(randomUUID(), project.id, "running");
    const entered = barrier(),
      release = barrier();
    const registry = createRegistry();
    let toolCalls = 0;
    const hold = defineTool({
      name: "hold",
      description: "test barrier",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async () => {
        toolCalls++;
        entered.resolve();
        await release.promise;
        return { output: [{ type: "text" as const, text: "released" }] };
      },
    });
    registry.install(defineExtension({ name: "hold", tools: [hold] }));
    const models = createModels();
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("resumed answer"),
    ]);
    models.setProvider(faux.provider);
    const receiptRelease = barrier();
    let agent: DurableAgent | undefined;
    try {
      (await database.migrate())._unsafeUnwrap();
      (await seedTestUser(task, database.users))._unsafeUnwrap();
      (await database.store.insertProject(task, project))._unsafeUnwrap();
      (await database.store.insertOrb(task, orb))._unsafeUnwrap();
      (await database.store.insertOrb(task, peer))._unsafeUnwrap();
      const lease = (
        await database.agentPersistence.open(task, orb, { signal: new AbortController().signal })
      )._unsafeUnwrap();
      const checkInputAdmission = vi.fn(lease.checkInputAdmission);
      agent = (
        await DurableAgent.open({
          orbId: orb.id,
          storage: lease.storage,
          models,
          registry,
          modelTools: [hold],
          env: new NodeExecutionEnv({ cwd: "/tmp" }),
          checkoutCommit: "commit",
          instructions: "",
          initialSettings: { model: { provider: "faux", id: "faux-1" }, thinkingLevel: "off" },
          ownershipSignal: lease.signal,
          checkAdmission: lease.check,
          checkInputAdmission,
          beginDrain: lease.beginDrain,
          closeResources: lease.release,
        })
      )._unsafeUnwrap();
      const currentAgent = agent;
      lease.signal.addEventListener(
        "abort",
        () => {
          currentAgent.revoke();
          void currentAgent.close();
        },
        { once: true },
      );
      const initial = (
        await agent.deliver({
          baseUrl: "central",
          messageId: randomUUID(),
          messageIds: [],
          content: [{ type: "text", text: "hold" }],
        })
      )._unsafeUnwrap();
      expect(
        await Promise.race([
          entered.promise.then(() => "held"),
          agent.waitForIdle().then(() => "idle"),
        ]),
      ).toBe("held");
      const readSubmission = async (messageId: string) =>
        (
          await lease.storage.scanSubmissions(
            { conversationId: ROOT_CONVERSATION_ID },
            100,
            undefined,
            BACKGROUND_CONTEXT,
          )
        ).items.find((row) => row.requestId === `inbox:${messageId}`);
      const peerRecords = (messageId: string) =>
        currentAgent
          .snapshot()
          ._unsafeUnwrap()
          .records.filter(
            (row) => row.type !== "compaction" && row.inboxMessageIds?.includes(messageId),
          );
      const sleep = () =>
        database.store.scheduleOrbSleep(task, {
          orbId: orb.id,
          caller: {
            kind: "central",
            orbId: orb.id,
            projectId: project.id,
            ownerUserId: project.ownerUserId,
            agentAdmissionVersion: 0,
          },
          sleepId: randomUUID(),
          durationSeconds: 300,
        });
      const sender = {
        orbId: peer.id,
        projectId: project.id,
        ownerUserId: project.ownerUserId,
        caller: {
          kind: "central" as const,
          orbId: peer.id,
          projectId: project.id,
          ownerUserId: project.ownerUserId,
          agentAdmissionVersion: 0,
        },
      };
      const queue = (
        messageId: string,
        content: Parameters<typeof database.store.enqueueOrbMessage>[1]["content"],
        fromPeer = false,
        now = 0,
      ) =>
        database.store.enqueueOrbMessage(task, {
          orbId: orb.id,
          messageId,
          content,
          now,
          ...(fromPeer ? { sender } : {}),
        });
      if (kind.endsWith("gap")) {
        const browser = kind.startsWith("browser");
        const messageId = browser ? "browser:gap" : randomUUID();
        const content = [{ type: "text" as const, text: "accepted steering" }];
        const system =
          kind === "peer-gap" ? { kind: "orb_message" as const, senderOrbId: peer.id } : undefined;
        if (!browser) {
          (await queue(messageId, content, kind === "peer-gap"))._unsafeUnwrap();
          (
            await database.store.claimNextOrbMessageBatch(task, { orbId: orb.id, now: 0 })
          )._unsafeUnwrap();
        }
        // Delay only the wrapper's receipt finalization, outside the Native mutation line.
        const root = Reflect.get(agent, "root") as Conversation;
        const submit = root.submit.bind(root);
        const submitted = barrier();
        vi.spyOn(root, "submit").mockImplementation(async (...args) => {
          const result = await submit(...args);
          if (args[0].requestId === `inbox:${messageId}`) {
            submitted.resolve();
            await receiptRelease.promise;
          }
          return result;
        });
        const request = {
          baseUrl: "central",
          messageId,
          messageIds: browser ? [] : [messageId],
          content,
          ...(system ? { system } : {}),
        };
        const admission = browser
          ? agent.request("gap", {
              type: "message",
              content,
              expectedHeadId: agent.snapshot()._unsafeUnwrap().headId,
            })
          : agent.deliver(request);
        await submitted.promise;
        expect(await readSubmission(messageId)).toMatchObject({ status: "queued" });
        const identityDocument = await lease.storage.findDocument(
          {
            kind: "orb.identity",
            scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID },
          },
          "current",
          BACKGROUND_CONTEXT,
        );
        const identity = await lease.storage.document(
          identityDocument?.id as NonNullable<typeof identityDocument>["id"],
          "current",
          BACKGROUND_CONTEXT,
        );
        expect(identity?.value.receipts).toMatchObject({
          [messageId]: { messageIds: request.messageIds },
        });
        expect(
          (identity?.value.receipts as Record<string, { submissionId?: number }> | undefined)?.[
            messageId
          ]?.submissionId,
        ).toBeUndefined();
        if (kind === "browser-peer-gap") {
          (
            await queue(randomUUID(), [{ type: "text", text: "later peer" }], true, 0)
          )._unsafeUnwrap();
        } else {
          (await sleep())._unsafeUnwrap();
        }
        release.resolve();
        const idle = await agent.waitForIdle();
        expect(idle.isOk(), idle.isErr() ? idle.error.message : "").toBe(true);
        expect(await readSubmission(messageId)).toMatchObject({ status: "done" });
        expect(faux.state.callCount).toBe(2);
        expect(toolCalls).toBe(1);
        expect(agent.health().status).toBe("ready");
        receiptRelease.resolve();
        expect((await admission).isOk()).toBe(true);
        const preflights = checkInputAdmission.mock.calls.length;
        expect((await agent.deliver(request))._unsafeUnwrap().duplicate).toBe(true);
        expect(checkInputAdmission).toHaveBeenCalledTimes(preflights);
        (await agent.waitForIdle())._unsafeUnwrap();
        expect(faux.state.callCount).toBe(2);
        if (!browser)
          expect(
            (await database.store.listOrbMessages(task, orb.id))._unsafeUnwrap()[0],
          ).toMatchObject({ status: "delivered", lastError: null });
        else if (kind === "browser-peer-gap")
          expect(
            (await database.store.listOrbMessages(task, orb.id))._unsafeUnwrap()[0],
          ).toMatchObject({ status: "queued", operationId: null });
        return;
      }
      const messageId = randomUUID();
      const requireOk = <T, E>(phase: string, result: Result<T, E>): T => {
        if (result.isErr())
          expect.fail(
            JSON.stringify({
              phase,
              error: result.error,
              health: currentAgent.health(),
              live: currentAgent.liveView(),
              records: currentAgent.snapshot(),
              modelCalls: faux.state.callCount,
              toolCalls,
            }),
          );
        return result._unsafeUnwrap();
      };
      const content = [{ type: "text" as const, text: "queued peer" }];
      const system = kind.startsWith("peer")
        ? { kind: "orb_message" as const, senderOrbId: peer.id }
        : undefined;
      requireOk("queue busy input", await queue(messageId, content, kind.startsWith("peer")));
      requireOk(
        "claim busy input",
        await database.store.claimNextOrbMessageBatch(task, { orbId: orb.id, now: 0 }),
      );
      const request = {
        baseUrl: "central",
        messageId,
        messageIds: [messageId],
        content,
        ...(system ? { system } : {}),
      };
      if (kind !== "peer-held") {
        const submit = vi.spyOn(Reflect.get(agent, "root") as Conversation, "submit");
        const admission = await agent.deliver(request);
        expect(submit).toHaveBeenCalledWith(
          expect.objectContaining({ whenBusy: "steer", requestId: `inbox:${messageId}` }),
          expect.anything(),
        );
        expect(admission._unsafeUnwrap()).toMatchObject({
          delivery: "steer",
          operationId: initial.operationId,
          duplicate: false,
        });
        expect(await readSubmission(messageId)).toMatchObject({ status: "queued" });
      } else {
        const browser = await agent.request("later-human", {
          type: "message",
          content: [{ type: "text", text: "later human" }],
          expectedHeadId: requireOk("snapshot before later browser", agent.snapshot()).headId,
        });
        expect(browser.isErr()).toBe(true);
        expect(browser._unsafeUnwrapErr()).toMatchObject({
          code: "history_unavailable",
          message: "Input admission waits for queued messages",
          retryable: true,
        });
        expect(agent.health()).toMatchObject({ status: "ready", activity: "busy" });
        expect(await readSubmission(messageId)).toBeUndefined();
      }
      requireOk("schedule Sleep", await sleep());
      release.resolve();
      requireOk("finish held turn during Sleep", await agent.waitForIdle());
      expect(faux.state.callCount).toBe(2);
      expect(lease.signal.aborted).toBe(false);
      if (kind !== "peer-held") {
        expect(
          (await database.store.listOrbMessages(task, orb.id))._unsafeUnwrap()[0],
        ).toMatchObject({ status: "delivered", lastError: null });
        expect(peerRecords(messageId)).toHaveLength(1);
        if (kind === "peer")
          expect(peerRecords(messageId)[0]).toMatchObject({
            type: "event",
            eventType: "orb.message",
            sender: { orbId: peer.id },
            content,
          });
        const preflights = checkInputAdmission.mock.calls.length;
        expect((await agent.deliver(request))._unsafeUnwrap()).toMatchObject({
          delivery: "steer",
          duplicate: true,
        });
        expect(checkInputAdmission).toHaveBeenCalledTimes(preflights);
        (await agent.waitForIdle())._unsafeUnwrap();
        expect(faux.state.callCount).toBe(2);
        expect(toolCalls).toBe(1);
        expect((await agent.prepareIdleStop())._unsafeUnwrap()).toEqual({ v: 1, prepared: true });
        const current = (await database.store.getOrb(task, orb.id))._unsafeUnwrap();
        if (current === null) throw new Error("seeded orb missing");
        expect(
          (
            await database.store.casTransition(task, {
              orbId: orb.id,
              expectedStateVersion: current.stateVersion,
              toState: "stopping",
              stopReason: "sleep",
              now: task.wallNow(),
            })
          )._unsafeUnwrap(),
        ).toMatchObject({ state: "stopping", stopReason: "sleep" });
        expect(peerRecords(messageId)).toHaveLength(1);
        return;
      }

      expect(peerRecords(messageId).length > 0).toBe(false);
      expect(
        requireOk("read held peer", await database.store.listOrbMessages(task, orb.id))[0],
      ).toMatchObject({
        status: "delivering",
        operationId: null,
        lastError: null,
      });
      const retry = await agent.deliver(request);
      expect(retry.isErr()).toBe(true);
      expect(retry._unsafeUnwrapErr()).toMatchObject({
        code: "history_unavailable",
        message: "Input admission paused by sleep",
        retryable: true,
      });
      expect(agent.health()).toMatchObject({ status: "ready", activity: "idle" });
      expect(lease.signal.aborted).toBe(false);
      expect((await readSubmission(messageId)) !== undefined).toBe(false);
      // Fresh peer admission is the legitimate wake; no receipt or request identity is replaced.
      requireOk(
        "queue fresh peer wake",
        await queue(randomUUID(), [{ type: "text", text: "wake" }], true, 1),
      );
      const freshOrb = requireOk("read after wake", await database.store.getOrb(task, orb.id));
      if (freshOrb === null) throw new Error("seeded orb missing");
      expect(freshOrb.sleepId).toBeNull();
      faux.appendResponses([fauxAssistantMessage("peer answer")]);
      expect(requireOk("admit peer after wake", await agent.deliver(request))).toMatchObject({
        duplicate: false,
        delivery: "turn",
      });
      requireOk("finish peer after wake", await agent.waitForIdle());
      expect(faux.state.callCount).toBe(3);
      expect(toolCalls).toBe(1);
      expect(requireOk("redeliver peer", await agent.deliver(request)).duplicate).toBe(true);
      requireOk("finish duplicate peer", await agent.waitForIdle());
      expect(faux.state.callCount).toBe(3);
      expect(
        requireOk("read delivered peer", await database.store.listOrbMessages(task, orb.id))[0],
      ).toMatchObject({ status: "delivered", lastError: null });
      expect(peerRecords(messageId)).toHaveLength(1);
    } finally {
      receiptRelease.resolve();
      release.resolve();
      await agent?.close();
      await database.close();
    }
  },
);

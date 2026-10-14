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
  createRegistry,
  defineExtension,
  defineTool,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { NoSimulationTask } from "determined";
import { expect, it } from "vitest";
import { makeOrbRow, makeProjectRow } from "../../testkit/fixtures.ts";
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

it.each(["peer", "human"] as const)(
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
        return { content: [{ type: "text" as const, text: "released" }] };
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
    let agent: DurableAgent | undefined;
    try {
      (await database.migrate())._unsafeUnwrap();
      (
        await database.users.resolveUser(
          task,
          { issuer: "test", subject: "owner", email: null },
          { id: project.ownerUserId, now: 0 },
        )
      )._unsafeUnwrap();
      (await database.store.insertProject(task, project))._unsafeUnwrap();
      (await database.store.insertOrb(task, orb))._unsafeUnwrap();
      (await database.store.insertOrb(task, peer))._unsafeUnwrap();
      const lease = (
        await database.agentPersistence.open(task, orb, { signal: new AbortController().signal })
      )._unsafeUnwrap();
      const open = (currentLease: typeof lease) =>
        DurableAgent.open({
          orbId: orb.id,
          storage: currentLease.storage,
          models,
          registry,
          modelTools: [hold],
          env: new NodeExecutionEnv({ cwd: "/tmp" }),
          checkoutCommit: "commit",
          instructions: "",
          initialSettings: { model: { provider: "faux", id: "faux-1" }, thinkingLevel: "off" },
          ownershipSignal: currentLease.signal,
          checkAdmission: currentLease.check,
          beginDrain: currentLease.beginDrain,
          closeResources: currentLease.release,
        });
      agent = (await open(lease))._unsafeUnwrap();
      const currentAgent = agent;
      lease.signal.addEventListener(
        "abort",
        () => {
          currentAgent.revoke();
          void currentAgent.close();
        },
        { once: true },
      );
      (
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
      const messageId = randomUUID();
      const content = [{ type: "text" as const, text: "queued peer" }];
      const system =
        kind === "peer" ? { kind: "orb_message" as const, senderOrbId: peer.id } : undefined;
      (
        await database.store.enqueueOrbMessage(task, {
          orbId: orb.id,
          messageId,
          content,
          ...(kind === "peer" ? { sender } : {}),
          now: 0,
        })
      )._unsafeUnwrap();
      (
        await database.store.claimNextOrbMessageBatch(task, { orbId: orb.id, now: 0 })
      )._unsafeUnwrap();
      const request = {
        baseUrl: "central",
        messageId,
        messageIds: [messageId],
        content,
        ...(system ? { system } : {}),
      };
      const admission = await agent.deliver(request);
      if (kind === "human") {
        expect(admission._unsafeUnwrap()).toMatchObject({ delivery: "steer", duplicate: false });
        expect(
          (
            await lease.storage.scanSubmissions(
              { conversationId: ROOT_CONVERSATION_ID },
              100,
              undefined,
              BACKGROUND_CONTEXT,
            )
          ).items.find((row) => row.requestId === `inbox:${messageId}`),
        ).toMatchObject({ status: "queued" });
      } else {
        const deferred = admission;
        expect(deferred.isErr()).toBe(true);
        expect(deferred._unsafeUnwrapErr()).toMatchObject({ retryable: true });
        const browser = await agent.request("later-human", {
          type: "message",
          content: [{ type: "text", text: "later human" }],
          expectedHeadId: agent.snapshot()._unsafeUnwrap().records.at(-1)?.id ?? null,
        });
        expect(browser.isErr()).toBe(true);
        expect(browser._unsafeUnwrapErr()).toMatchObject({ retryable: true });
        expect(
          (
            await lease.storage.scanSubmissions(
              { conversationId: ROOT_CONVERSATION_ID },
              100,
              undefined,
              BACKGROUND_CONTEXT,
            )
          ).items.some((row) => row.requestId === `inbox:${messageId}`),
        ).toBe(false);
      }
      (
        await database.store.scheduleOrbSleep(task, {
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
        })
      )._unsafeUnwrap();
      release.resolve();
      (await agent.waitForIdle())._unsafeUnwrap();
      expect(faux.state.callCount).toBe(2);
      expect(lease.signal.aborted).toBe(false);
      if (kind === "human") {
        expect(
          (await database.store.listOrbMessages(task, orb.id))._unsafeUnwrap()[0],
        ).toMatchObject({ status: "delivered", lastError: null });
        expect(
          agent
            .snapshot()
            ._unsafeUnwrap()
            .records.filter(
              (row) => row.type !== "compaction" && row.inboxMessageIds?.includes(messageId),
            ),
        ).toHaveLength(1);
        expect((await agent.deliver(request))._unsafeUnwrap()).toMatchObject({
          delivery: "steer",
          duplicate: true,
        });
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
        expect(
          agent
            .snapshot()
            ._unsafeUnwrap()
            .records.filter(
              (row) => row.type !== "compaction" && row.inboxMessageIds?.includes(messageId),
            ),
        ).toHaveLength(1);
        return;
      }

      expect(
        agent
          .snapshot()
          ._unsafeUnwrap()
          .records.some(
            (row) => row.type !== "compaction" && row.inboxMessageIds?.includes(messageId),
          ),
      ).toBe(false);
      expect((await database.store.listOrbMessages(task, orb.id))._unsafeUnwrap()[0]).toMatchObject(
        {
          status: "delivering",
          operationId: null,
          lastError: null,
        },
      );
      const retry = await agent.deliver(request);
      expect(retry.isErr()).toBe(true);
      expect(retry._unsafeUnwrapErr()).toMatchObject({ retryable: true });
      expect(
        (
          await lease.storage.scanSubmissions(
            { conversationId: ROOT_CONVERSATION_ID },
            100,
            undefined,
            BACKGROUND_CONTEXT,
          )
        ).items.some((row) => row.requestId === `inbox:${messageId}`),
      ).toBe(false);
      // Fresh peer admission is the legitimate wake; no receipt or request identity is replaced.
      (
        await database.store.enqueueOrbMessage(task, {
          orbId: orb.id,
          messageId: randomUUID(),
          content: [{ type: "text", text: "wake" }],
          sender,
          now: 1,
        })
      )._unsafeUnwrap();
      const freshOrb = (await database.store.getOrb(task, orb.id))._unsafeUnwrap();
      if (freshOrb === null) throw new Error("seeded orb missing");
      expect(freshOrb.sleepId).toBeNull();
      faux.appendResponses([fauxAssistantMessage("peer answer")]);
      expect((await agent.deliver(request))._unsafeUnwrap()).toMatchObject({
        duplicate: false,
        delivery: "turn",
      });
      (await agent.waitForIdle())._unsafeUnwrap();
      expect(faux.state.callCount).toBe(3);
      expect(toolCalls).toBe(1);
      expect((await agent.deliver(request))._unsafeUnwrap().duplicate).toBe(true);
      (await agent.waitForIdle())._unsafeUnwrap();
      expect(faux.state.callCount).toBe(3);
      expect((await database.store.listOrbMessages(task, orb.id))._unsafeUnwrap()[0]).toMatchObject(
        {
          status: "delivered",
          lastError: null,
        },
      );
      expect(
        agent
          .snapshot()
          ._unsafeUnwrap()
          .records.filter(
            (row) => row.type !== "compaction" && row.inboxMessageIds?.includes(messageId),
          ),
      ).toHaveLength(1);
    } finally {
      release.resolve();
      await agent?.close();
      await database.close();
    }
  },
);

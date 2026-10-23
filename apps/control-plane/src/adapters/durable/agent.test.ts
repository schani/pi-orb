import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createAssistantMessageEventStream, Type } from "@earendil-works/pi-ai";
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
  defineTool,
  GenerationTask,
  hook,
  LiveDoc,
  MemoryStorage,
  ROOT_CONVERSATION_ID,
  type Storage,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { type ServerFrame, ServerFrameSchema } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { StorageFailure } from "../durable-pg/storage-boundary.ts";
import { DurableAgent } from "./agent.ts";
import { durableError } from "./manager.ts";
import { MemoryAgentPersistence } from "./memory-persistence.testkit.ts";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const initialSettings = {
  model: { provider: "faux", id: "faux-1" },
  thinkingLevel: "off" as const,
};
const input = {
  baseUrl: "unused",
  messageId: "input",
  messageIds: ["input"],
  content: [{ type: "text" as const, text: "question" }],
};

describe("central Durable agent", () => {
  it.each(["setup", "resume"] as const)(
    "exposes failed %s unchanged while remaining available",
    async (hook) => {
      const hooks = {
        [hook]: {
          hook,
          outcome: "failed" as const,
          exitCode: 3,
          incarnation: "3",
          startedAt: "2026-08-06T00:00:00Z",
          endedAt: "2026-08-06T00:00:01Z",
          logPath: `/home/.cache/pi-orb/logs/${hook}.log`,
        },
      };
      const models = createModels();
      models.setProvider(fauxProvider().provider);
      const agent = (
        await DurableAgent.open({
          orbId: "orb",
          storage: new MemoryStorage(),
          models,
          registry: createRegistry(),
          env: new NodeExecutionEnv({ cwd: "/tmp" }),
          checkoutCommit: "commit",
          hooks,
          instructions: "",
          initialSettings,
        })
      )._unsafeUnwrap();
      try {
        expect(agent.health()).toMatchObject({ status: "ready", activity: "idle", hooks });
        expect(agent.health()).toHaveProperty("hooks", hooks);
      } finally {
        await agent.close();
      }
    },
  );

  it("summarizes completed root turns without blocking inference and drains cancellation on close", async () => {
    const models = createModels();
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage([
        { type: "thinking", thinking: "PRIVATE reasoning" },
        { type: "text", text: "answer" },
      ]),
      fauxAssistantMessage("second answer"),
    ]);
    models.setProvider(faux.provider);
    const entered = barrier();
    const cancelled = barrier();
    const notified = barrier();
    const inputs: string[] = [];
    const edges: string[] = [];
    const agent = (
      await DurableAgent.open({
        orbId: "orb",
        storage: new MemoryStorage(),
        models,
        registry: createRegistry(),
        env: new NodeExecutionEnv({ cwd: "/tmp" }),
        checkoutCommit: "commit",
        instructions: "PRIVATE instruction",
        initialSettings,
        edge: (code) => {
          edges.push(code);
          return okAsync(undefined);
        },
        turnSummary: {
          task: new NoSimulationTask("summary-test", false),
          summarizer: {
            summarize: (input, { signal }) => {
              inputs.push(input.transcript);
              if (inputs.length === 1) return okAsync("Changed files.");
              entered.resolve();
              return ResultAsync.fromSafePromise(
                new Promise<string>((resolve) =>
                  signal.addEventListener(
                    "abort",
                    () => {
                      cancelled.resolve();
                      resolve("cancelled");
                    },
                    { once: true },
                  ),
                ),
              );
            },
          },
        },
      })
    )._unsafeUnwrap();
    const frames: ServerFrame[] = [];
    agent.subscribe((frame) => {
      frames.push(frame);
      if (frame.type === "runtime.event" && frame.event.type === "turn_notification")
        notified.resolve();
    });
    try {
      await agent.deliver(input);
      await agent.waitForIdle();
      await notified.promise;
      expect(inputs[0]).toContain("User: question");
      expect(inputs[0]).toContain("Agent: answer");
      expect(inputs[0]).not.toContain("PRIVATE");
      await agent.deliver({
        ...input,
        messageId: "second",
        messageIds: ["second"],
        content: [{ type: "text", text: "next" }],
      });
      await agent.waitForIdle();
      await entered.promise;
      expect(agent.health()).toMatchObject({ status: "ready", activity: "idle" });
      expect((await agent.prepareIdleStop())._unsafeUnwrap()).toEqual({ v: 1, prepared: false });
      expect(inputs[1]).not.toContain("User: question");
      await agent.close();
      await cancelled.promise;
      expect(
        frames.filter(
          (frame) => frame.type === "runtime.event" && frame.event.type === "turn_notification",
        ),
      ).toHaveLength(1);
      expect(edges).toContain("harness.summary_queued");
      expect(edges).toContain("harness.summary_failed");
    } finally {
      await agent.close();
    }
  });
  it("isolates summary failures from agent health", async () => {
    const models = createModels();
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage("answer")]);
    models.setProvider(faux.provider);
    const failed = barrier();
    const agent = (
      await DurableAgent.open({
        orbId: "orb",
        storage: new MemoryStorage(),
        models,
        registry: createRegistry(),
        env: new NodeExecutionEnv({ cwd: "/tmp" }),
        checkoutCommit: "commit",
        instructions: "instruction",
        initialSettings,
        turnSummary: {
          task: new NoSimulationTask("summary-failure", false),
          summarizer: {
            summarize: () =>
              errAsync({ type: "turn_summary_error", message: "PRIVATE credentials" }),
          },
        },
        edge: (code, facts) => {
          if (code === "harness.summary_failed") {
            expect(JSON.stringify(facts)).not.toContain("PRIVATE");
            failed.resolve();
          }
          return okAsync(undefined);
        },
      })
    )._unsafeUnwrap();
    try {
      await agent.deliver(input);
      await agent.waitForIdle();
      await failed.promise;
      expect(agent.health()).toMatchObject({ status: "ready", activity: "idle" });
      expect(agent.snapshot().isOk()).toBe(true);
      expect((await agent.prepareIdleStop())._unsafeUnwrap()).toEqual({ v: 1, prepared: true });
    } finally {
      await agent.close();
    }
  });

  it("checks the browser head after preceding queued mutations commit", async () => {
    const models = createModels();
    models.setProvider(fauxProvider().provider);
    const entered = barrier();
    const release = barrier();
    const agent = (
      await DurableAgent.open({
        orbId: "orb",
        storage: new MemoryStorage(),
        models,
        registry: createRegistry(),
        env: new NodeExecutionEnv({ cwd: "/tmp" }),
        checkoutCommit: "commit",
        instructions: "instruction",
        initialSettings,
        commitHistory: (snapshot) =>
          snapshot.records.some((record) => record.type === "event" && record.alert)
            ? (entered.resolve(),
              ResultAsync.fromPromise(release.promise, () => durableError("barrier")))
            : okAsync(undefined),
      })
    )._unsafeUnwrap();
    try {
      const alert = agent.appendAlert("alert", "changed head");
      const request = agent.request("browser", {
        type: "message",
        expectedHeadId: null,
        content: input.content,
      });
      await entered.promise;
      release.resolve();
      await alert;
      expect((await request)._unsafeUnwrap()).toMatchObject({
        type: "rejected",
        error: { code: "stale_head" },
      });
    } finally {
      release.resolve();
      await agent.close();
    }
  });
  it("releases resources when initialization and native cleanup both reject", async () => {
    const storage = new MemoryStorage();
    storage.close = async () => {
      throw new Error("PRIVATE cleanup");
    };
    const registry = createRegistry();
    registry.install = () => {
      throw new Error("PRIVATE initialization");
    };
    let closes = 0;
    const opened = await DurableAgent.open({
      orbId: "orb",
      storage,
      models: createModels(),
      registry,
      env: new NodeExecutionEnv({ cwd: "/tmp" }),
      checkoutCommit: "commit",
      instructions: "instruction",
      closeResources: () => {
        closes++;
        return okAsync(undefined);
      },
    });
    expect(opened.isErr()).toBe(true);
    expect(JSON.stringify(opened)).not.toContain("PRIVATE");
    expect(closes).toBe(1);
  });

  it("releases tool resources even when native storage close rejects", async () => {
    const storage = new MemoryStorage();
    const nativeClose = storage.close.bind(storage);
    storage.close = async (context) => {
      await nativeClose(context);
      throw new Error("PRIVATE close details");
    };
    const models = createModels();
    models.setProvider(fauxProvider().provider);
    let closes = 0;
    const agent = (
      await DurableAgent.open({
        orbId: "orb",
        storage,
        models,
        registry: createRegistry(),
        env: new NodeExecutionEnv({ cwd: "/tmp" }),
        checkoutCommit: "commit",
        instructions: "instruction",
        initialSettings,
        closeResources: () => {
          closes++;
          return okAsync(undefined);
        },
      })
    )._unsafeUnwrap();
    const closed = await agent.close();
    expect(closed.isErr()).toBe(true);
    expect(JSON.stringify(closed)).not.toContain("PRIVATE");
    expect(closes).toBe(1);
    expect((await agent.close()).isErr()).toBe(true);
    expect(closes).toBe(1);
  });

  it("publishes a sanitized hook report without poisoning a recoverable agent", async () => {
    const models = createModels();
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage("answer")]);
    models.setProvider(faux.provider);
    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: "report-fixture",
        hooks: [
          hook(GenerationTask, {
            afterResponse: () => {
              throw new Error("PRIVATE credential");
            },
          }),
        ],
      }),
    );
    const frames: ServerFrame[] = [];
    const edges: string[] = [];
    const agent = (
      await DurableAgent.open({
        orbId: "orb",
        storage: new MemoryStorage(),
        models,
        registry,
        env: new NodeExecutionEnv({ cwd: "/tmp" }),
        checkoutCommit: "commit",
        instructions: "instruction",
        initialSettings,
        edge: (code) => {
          edges.push(code);
          return okAsync(undefined);
        },
      })
    )._unsafeUnwrap();
    agent.subscribe((frame) => frames.push(frame));
    try {
      await agent.deliver(input);
      await agent.waitForIdle();
      expect(agent.health().status).toBe("ready");
      expect((await agent.pullHistory(null, 100))._unsafeUnwrap().records).toContainEqual(
        expect.objectContaining({ role: "assistant" }),
      );
      expect(edges).toContain("harness.reported_failure");
      expect(frames).toContainEqual(
        expect.objectContaining({
          type: "server.error",
          error: {
            code: "central_agent_report",
            message: "Agent extension reported a failure",
            retryable: false,
          },
        }),
      );
      expect(JSON.stringify({ edges, frames })).not.toContain("PRIVATE");
    } finally {
      await agent.close();
    }
  });

  it("commits typed alerts before returning a stable, deduplicated native record ID", async () => {
    const directory = await mkdtemp(join(tmpdir(), "durable-alert-"));
    const authority = new MemoryAgentPersistence();
    const models = createModels();
    const faux = fauxProvider();
    let requests = 0;
    faux.setResponses([
      () => {
        requests++;
        return fauxAssistantMessage("unexpected");
      },
    ]);
    models.setProvider(faux.provider);
    const entered = barrier();
    const release = barrier();
    let hold = true;
    const open = async () =>
      (
        await DurableAgent.open({
          orbId: "orb",
          storage: (await authority.openOrb("orb", true))._unsafeUnwrap().storage,
          models,
          registry: createRegistry(),
          env: new NodeExecutionEnv({ cwd: directory }),
          checkoutCommit: "commit",
          instructions: "PRIVATE",
          initialSettings,
        })
      )._unsafeUnwrap();
    // The projection barrier must complete before admission is acknowledged.
    const agent = (
      await DurableAgent.open({
        orbId: "orb",
        storage: (await authority.openOrb("orb", false))._unsafeUnwrap().storage,
        models,
        registry: createRegistry(),
        env: new NodeExecutionEnv({ cwd: directory }),
        checkoutCommit: "commit",
        instructions: "PRIVATE",
        initialSettings,
        commitHistory: (snapshot) => {
          if (hold && snapshot.records.some((record) => record.type === "event" && record.alert)) {
            entered.resolve();
            return ResultAsync.fromPromise(release.promise, () => durableError("fixture barrier"));
          }
          return okAsync(undefined);
        },
      })
    )._unsafeUnwrap();
    try {
      let acknowledged = false;
      const pending = agent.appendAlert("alert-1", "look here").map((receipt) => {
        acknowledged = true;
        return receipt;
      });
      await entered.promise;
      expect(acknowledged).toBe(false);
      hold = false;
      release.resolve();
      const receipt = (await pending)._unsafeUnwrap();
      expect(receipt.duplicate).toBe(false);
      expect((await agent.appendAlert("alert-1", "look here"))._unsafeUnwrap()).toEqual({
        ...receipt,
        duplicate: true,
      });
      expect((await agent.appendAlert("alert-1", "changed")).isErr()).toBe(true);
      expect(agent.snapshot()._unsafeUnwrap().records).toMatchObject([
        { type: "event", eventType: "pi.model_change" },
        { type: "event", eventType: "pi.thinking_level_change" },
        {
          id: receipt.recordId,
          type: "event",
          eventType: "orb.alert",
          alert: { requestId: "alert-1", message: "look here" },
        },
      ]);
      await agent.close();
      const reopened = await open();
      try {
        expect((await reopened.appendAlert("alert-1", "look here"))._unsafeUnwrap()).toEqual({
          ...receipt,
          duplicate: true,
        });
        expect(reopened.snapshot()._unsafeUnwrap().records).toHaveLength(3);
        expect(JSON.stringify(reopened.snapshot()._unsafeUnwrap().records)).not.toContain(
          "PRIVATE",
        );
        expect(requests).toBe(0);
      } finally {
        await reopened.close();
      }
    } finally {
      release.resolve();
      await agent.close();
      await authority.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("preserves the Sol/high product default and records the central process owner", async () => {
    const models = createModels();
    models.setProvider(fauxProvider().provider);
    const edges: { code: string; facts: Readonly<Record<string, string | number | boolean>> }[] =
      [];
    const agent = (
      await DurableAgent.open({
        orbId: "orb",
        storage: new MemoryStorage(),
        models,
        registry: createRegistry(),
        env: new NodeExecutionEnv({ cwd: "/tmp" }),
        checkoutCommit: "commit",
        instructions: "instruction",
        edge: (code, facts) => {
          edges.push({ code, facts });
          return okAsync(undefined);
        },
      })
    )._unsafeUnwrap();
    try {
      expect(agent.snapshot()._unsafeUnwrap().settings?.settings).toEqual({
        model: { provider: "openai-codex", id: "gpt-6.1-sol" },
        thinkingLevel: "high",
      });
      expect(edges).toContainEqual({
        code: "harness.opened",
        facts: {
          orbId: "orb",
          sessionId: agent.snapshot()._unsafeUnwrap().session.id,
          recovered: false,
          readonly: false,
          processId: process.pid,
        },
      });
    } finally {
      await agent.close();
    }
  });

  it("durably deduplicates input and projects completed assistant history", async () => {
    const faux = fauxProvider();
    const contexts: string[] = [];
    faux.setResponses(
      Array(2).fill((request: { messages: unknown }) => {
        contexts.push(JSON.stringify(request.messages));
        return fauxAssistantMessage("answer");
      }),
    );
    const models = createModels();
    models.setProvider(faux.provider);
    const agent = (
      await DurableAgent.open({
        orbId: "orb",
        storage: new MemoryStorage(),
        models,
        registry: createRegistry(),
        env: new NodeExecutionEnv({ cwd: "/tmp" }),
        checkoutCommit: "commit",
        instructions: "instruction",
        initialSettings: { model: { provider: "faux", id: "faux-1" }, thinkingLevel: "off" },
      })
    )._unsafeUnwrap();
    const request = {
      baseUrl: "unused",
      messageId: "one",
      messageIds: ["one"],
      content: [{ type: "text" as const, text: "question" }],
    };
    const peers = [1, 2].map((n) => ({
      ...request,
      messageId: `peer-${n}`,
      messageIds: [`peer-${n}`],
      content: [{ type: "text" as const, text: `peer body ${n}` }],
      system: {
        kind: "orb_message" as const,
        senderOrbId: `00000000-0000-4000-8000-00000000000${n}`,
      },
    }));
    const receipts = (await agent.deliverMany([peers[0]!, request, peers[1]!]))
      ._unsafeUnwrap()
      .map((r) => r._unsafeUnwrap());
    expect(receipts[1]?.duplicate).toBe(false);
    expect(new Set(receipts.map((r) => r.operationId)).size).toBe(1);
    expect((await agent.deliver(request))._unsafeUnwrap().duplicate).toBe(true);
    expect(
      (await agent.deliver({ ...request, content: [{ type: "text", text: "different" }] })).isErr(),
    ).toBe(true);
    await agent.waitForIdle();
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatch(/peer body 1[\s\S]*question[\s\S]*peer body 2/);
    const snapshot = agent.snapshot()._unsafeUnwrap();
    expect(
      snapshot.records.filter((r) => r.type === "event" && r.eventType === "orb.message"),
    ).toMatchObject(
      peers.map((p) => ({
        sender: { orbId: p.system.senderOrbId },
        inboxMessageIds: p.messageIds,
      })),
    );
    expect(
      snapshot.records.filter((record) => record.type === "message" && record.role === "user"),
    ).toHaveLength(1);
    expect(
      snapshot.records.some((record) => record.type === "message" && record.role === "assistant"),
    ).toBe(true);
    expect(snapshot.activity).toBe("idle");
    expect((await agent.prepareIdleStop())._unsafeUnwrap().prepared).toBe(true);
    const mixed = await agent.deliverMany([
      peers[0]!,
      { ...request, messageId: "after-stop", messageIds: ["after-stop"] },
    ]);
    expect(mixed.isOk()).toBe(true);
    expect(mixed._unsafeUnwrap().map((r) => r._unsafeUnwrap().duplicate)).toEqual([true, false]);
    expect(mixed._unsafeUnwrap()[0]!._unsafeUnwrap()).toEqual({ ...receipts[0]!, duplicate: true });
    await agent.waitForIdle();
    expect(contexts).toHaveLength(2);
    expect(
      agent
        .snapshot()
        ._unsafeUnwrap()
        .records.filter((r) => r.type === "event" && r.eventType === "orb.message"),
    ).toHaveLength(2);
    expect((await agent.close()).isOk()).toBe(true);
    expect((await agent.deliver(request)).isErr()).toBe(true);
  });

  it("closes tool resources exactly once on suspension and failed initialization", async () => {
    const models = createModels();
    models.setProvider(fauxProvider().provider);
    let closes = 0;
    const options = {
      orbId: "orb",
      models,
      env: new NodeExecutionEnv({ cwd: "/tmp" }),
      checkoutCommit: "commit",
      instructions: "instruction",
      initialSettings,
      closeResources: () => {
        closes++;
        return okAsync(undefined);
      },
    };
    const agent = (
      await DurableAgent.open({
        ...options,
        storage: new MemoryStorage(),
        registry: createRegistry(),
      })
    )._unsafeUnwrap();
    expect((await agent.close()).isOk()).toBe(true);
    expect((await agent.close()).isOk()).toBe(true);
    expect(closes).toBe(1);
    expect(
      (
        await DurableAgent.open({
          ...options,
          storage: new MemoryStorage(),
          registry: createRegistry(),
          edge: () => errAsync(durableError("fixture initialization failure")),
        })
      ).isErr(),
    ).toBe(true);
    expect(closes).toBe(2);
  });

  it("consumes admitted steering input after the preceding run fails", async () => {
    const entered = barrier();
    const release = barrier();
    const faux = fauxProvider();
    faux.setResponses([
      async () => {
        entered.resolve();
        await release.promise;
        return fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "scripted terminal failure",
        });
      },
      fauxAssistantMessage("queued answer"),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const agent = (
      await DurableAgent.open({
        orbId: "orb",
        storage: new MemoryStorage(),
        models,
        registry: createRegistry(),
        env: new NodeExecutionEnv({ cwd: "/tmp" }),
        checkoutCommit: "commit",
        instructions: "instruction",
        initialSettings,
      })
    )._unsafeUnwrap();
    try {
      await agent.deliver(input);
      await entered.promise;
      await agent.deliver({ ...input, messageId: "steer", messageIds: ["steer"] });
      release.resolve();
      await agent.waitForIdle();
      expect(faux.state.callCount).toBe(2);
      expect(agent.snapshot()._unsafeUnwrap().activity).toBe("idle");
      expect((await agent.prepareIdleStop())._unsafeUnwrap().prepared).toBe(true);
    } finally {
      release.resolve();
      await agent.close();
    }
  });

  it("retains sleep-wake notice identity as a system event rather than a user bubble", async () => {
    const faux = fauxProvider();
    const contexts: string[] = [];
    faux.setResponses([
      (context) => {
        contexts.push(JSON.stringify(context.messages));
        return fauxAssistantMessage("awake");
      },
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const agent = (
      await DurableAgent.open({
        orbId: "orb",
        storage: new MemoryStorage(),
        models,
        registry: createRegistry(),
        env: new NodeExecutionEnv({ cwd: "/tmp" }),
        checkoutCommit: "commit",
        instructions: "instruction",
        initialSettings,
      })
    )._unsafeUnwrap();
    try {
      expect(faux.state.callCount).toBe(0);
      const wake = {
        ...input,
        content: [{ type: "text" as const, text: "Scheduled sleep finished." }],
        system: { kind: "sleep_wake" as const, sleepUntil: "2026-10-03T00:00:00.000Z" },
      };
      expect((await agent.deliver(wake))._unsafeUnwrap().duplicate).toBe(false);
      expect((await agent.deliver(wake))._unsafeUnwrap().duplicate).toBe(true);
      await agent.waitForIdle();
      expect(agent.snapshot()._unsafeUnwrap().records.slice(0, 2)).toMatchObject([
        { eventType: "pi.model_change" },
        { eventType: "pi.thinking_level_change" },
      ]);
      expect(agent.snapshot()._unsafeUnwrap().records[2]).toMatchObject({
        type: "event",
        eventType: "pi.custom_message",
        custom: { customType: "pi-orb.sleep-wake", display: true },
        inboxMessageIds: ["input"],
      });
      expect(contexts).toHaveLength(1);
      expect(contexts[0]).toContain("The host was restarted.");
      expect(contexts[0]).toContain("Scheduled sleep finished.");
      expect(contexts[0]).toContain("All processes running before the restart were killed");
      expect(
        agent
          .snapshot()
          ._unsafeUnwrap()
          .records.filter(
            (record) =>
              record.type === "event" && record.custom?.customType === "pi-orb.sleep-wake",
          ),
      ).toHaveLength(1);
    } finally {
      await agent.close();
    }
  });

  it("fails drain visibly when derived history cannot commit but still releases its Harness", async () => {
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage("answer")]);
    const models = createModels();
    models.setProvider(faux.provider);
    const edges: string[] = [];
    const agent = (
      await DurableAgent.open({
        orbId: "orb",
        storage: new MemoryStorage(),
        models,
        registry: createRegistry(),
        env: new NodeExecutionEnv({ cwd: "/tmp" }),
        checkoutCommit: "commit",
        instructions: "instruction",
        initialSettings,
        commitHistory: (snapshot) =>
          snapshot.records.some((record) => record.type === "message")
            ? errAsync(durableError("projection unavailable", true))
            : okAsync(undefined),
        edge: (code) => {
          edges.push(code);
          return okAsync(undefined);
        },
      })
    )._unsafeUnwrap();
    await agent.deliver(input);
    await agent.waitForIdle();
    expect(agent.snapshot().isErr()).toBe(true);
    expect(agent.health().status).toBe("failed");
    expect((await agent.prepareIdleStop()).isErr()).toBe(true);
    expect(edges).toContain("history.projection_failed");
    expect((await agent.deliver({ ...input, messageId: "new", messageIds: ["new"] })).isErr()).toBe(
      true,
    );
    expect((await agent.close()).isOk()).toBe(true);
  });

  it("reopens an already-prepared request with current instructions and stable input identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "durable-prepared-"));
    const authority = new MemoryAgentPersistence();
    const entered = barrier();
    const firstModel = fauxProvider();
    firstModel.setResponses([
      (_request, options) =>
        new Promise((resolve) => {
          entered.resolve();
          options?.signal?.addEventListener(
            "abort",
            () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
            { once: true },
          );
        }),
    ]);
    const firstModels = createModels();
    firstModels.setProvider(firstModel.provider);
    const first = (
      await DurableAgent.open({
        orbId: "orb",
        storage: (await authority.openOrb("orb", false))._unsafeUnwrap().storage,
        models: firstModels,
        registry: createRegistry(),
        env: new NodeExecutionEnv({ cwd: directory }),
        checkoutCommit: "commit",
        instructions: "OLD",
        initialSettings,
      })
    )._unsafeUnwrap({ withStackTrace: true });
    try {
      const outcomes: string[] = [];
      const observeOutcome = (frame: ServerFrame) => {
        if (frame.type === "runtime.event" && frame.event.type === "operation_finished")
          outcomes.push(frame.event.outcome);
      };
      first.subscribe(observeOutcome);
      const receipt = (await first.deliver(input))._unsafeUnwrap();
      await entered.promise;
      expect((await first.close()).isOk()).toBe(true);
      expect(outcomes).not.toContain("aborted");
      let current = "";
      let resumedRequests = 0;
      const secondModel = fauxProvider();
      secondModel.setResponses([
        (request) => {
          resumedRequests++;
          expect(JSON.stringify(request.messages)).not.toContain("recovery is resuming");
          current = JSON.stringify(
            request.messages.filter((message) => message.role === "system").at(-1),
          );
          return fauxAssistantMessage("resumed");
        },
      ]);
      const secondModels = createModels();
      secondModels.setProvider(secondModel.provider);
      const refused = await DurableAgent.open({
        orbId: "orb",
        storage: (await authority.openOrb("orb", true))._unsafeUnwrap().storage,
        models: secondModels,
        registry: createRegistry(),
        env: new NodeExecutionEnv({ cwd: directory }),
        checkoutCommit: "commit",
        instructions: "NEW",
        initialSettings,
        admitRecovery: () => errAsync(durableError("restart budget exhausted")),
      });
      expect(refused.isErr() && refused.error.message).toBe("restart budget exhausted");
      let recoveriesAdmitted = 0;
      const second = (
        await DurableAgent.open({
          orbId: "orb",
          storage: (await authority.openOrb("orb", true))._unsafeUnwrap().storage,
          models: secondModels,
          registry: createRegistry(),
          env: new NodeExecutionEnv({ cwd: directory }),
          checkoutCommit: "commit",
          instructions: "NEW",
          initialSettings,
          admitRecovery: () => {
            recoveriesAdmitted++;
            return okAsync(undefined);
          },
        })
      )._unsafeUnwrap({ withStackTrace: true });
      expect(recoveriesAdmitted).toBe(1);
      try {
        second.subscribe(observeOutcome);
        expect((await second.deliver(input))._unsafeUnwrap().operationId).toBe(receipt.operationId);
        await second.waitForIdle();
        expect(outcomes.at(-1)).toBe("completed");
        expect(outcomes).not.toContain("aborted");
        expect(current).toContain("NEW");
        expect(resumedRequests).toBe(1);
        const records = second.snapshot()._unsafeUnwrap().records;
        expect(
          records.filter(
            (record) =>
              record.type === "event" && record.custom?.customType === "pi-orb.harness-restarted",
          ),
        ).toMatchObject([
          {
            eventType: "pi.custom_message",
            content: [
              {
                type: "text",
                text: "Agent harness restarted with unfinished work; recovery is resuming.",
              },
            ],
          },
        ]);
        expect(
          records.filter((record) => record.type === "message" && record.role === "user"),
        ).toHaveLength(1);
      } finally {
        await second.close();
      }
    } finally {
      await first.close();
      await authority.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves image input and emits valid lightweight browser frames", async () => {
    const faux = fauxProvider({ models: [{ id: "faux-1", input: ["text", "image"] }] });
    let modelContext = "";
    faux.setResponses([
      (request) => {
        modelContext = JSON.stringify(request.messages);
        return fauxAssistantMessage("image accepted");
      },
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const agent = (
      await DurableAgent.open({
        orbId: "orb",
        storage: new MemoryStorage(),
        models,
        registry: createRegistry(),
        env: new NodeExecutionEnv({ cwd: "/tmp" }),
        checkoutCommit: "commit",
        instructions: "instruction",
        initialSettings,
      })
    )._unsafeUnwrap();
    const frames: ServerFrame[] = [];
    agent.subscribe((frame) => frames.push(frame));
    try {
      expect(
        (
          await agent.deliver({
            ...input,
            content: [{ type: "image", mediaType: "image/png", data: "eA==" }],
          })
        ).isOk(),
      ).toBe(true);
      await agent.waitForIdle();
      expect(modelContext).toContain("eA==");
      expect(
        agent
          .snapshot()
          ._unsafeUnwrap()
          .records.some(
            (record) =>
              record.type === "message" && record.content.some((block) => block.type === "image"),
          ),
      ).toBe(true);
      for (const frame of frames)
        expect(Check(ServerFrameSchema, frame), JSON.stringify(frame)).toBe(true);
    } finally {
      await agent.close();
    }
  });

  it("keeps full reasoning in authority and publishes only lazy display manifests", async () => {
    const faux = fauxProvider();
    const reasoning = `Investigate the repository\n\n${"PRIVATE_REASONING_BODY ".repeat(100)}`;
    faux.setResponses([
      () =>
        fauxAssistantMessage([
          { type: "thinking", thinking: reasoning },
          { type: "text", text: "answer" },
        ]),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const agent = (
      await DurableAgent.open({
        orbId: "orb",
        storage: new MemoryStorage(),
        models,
        registry: createRegistry(),
        env: new NodeExecutionEnv({ cwd: "/tmp" }),
        checkoutCommit: "commit",
        instructions: "PRIVATE_INSTRUCTIONS",
        initialSettings,
      })
    )._unsafeUnwrap();
    const frames: ServerFrame[] = [];
    agent.subscribe((frame) => frames.push(frame));
    try {
      (await agent.deliver(input))._unsafeUnwrap();
      await agent.waitForIdle();
      expect(JSON.stringify(agent.snapshot()._unsafeUnwrap().records)).toContain(
        "PRIVATE_REASONING_BODY",
      );
      expect(JSON.stringify(frames)).not.toContain("PRIVATE_REASONING_BODY");
      expect(JSON.stringify(frames)).not.toContain("PRIVATE_INSTRUCTIONS");
      const record = frames.find(
        (frame) =>
          frame.type === "history.record" &&
          frame.record.type === "message" &&
          frame.record.role === "assistant",
      );
      expect(
        record?.type === "history.record" && record.record.type === "message"
          ? record.record.content
          : [],
      ).toContainEqual(
        expect.objectContaining({
          type: "reasoning",
          detailKey: expect.any(String),
          headline: expect.any(String),
        }),
      );
      for (const frame of frames)
        expect(Check(ServerFrameSchema, frame), JSON.stringify(frame)).toBe(true);
    } finally {
      await agent.close();
    }
  });

  it("uses distinct live block identities across tool rounds", async () => {
    const faux = fauxProvider();
    const responses = [
      fauxAssistantMessage(
        [{ type: "text", text: "first round" }, fauxToolCall("noop", {}, { id: "noop-call" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("second round"),
    ] as const;
    const releases = [barrier(), barrier()] as const;
    let round = 0;
    const models = createModels();
    models.setProvider({
      ...faux.provider,
      streamSimple: () => {
        const index = round++ === 0 ? 0 : 1;
        const message = responses[index];
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "start", partial: message });
        stream.push({
          type: "text_delta",
          contentIndex: 0,
          delta: index === 0 ? "first round" : "second round",
          partial: message,
        });
        void releases[index].promise.then(() => {
          stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
          stream.end();
        });
        return stream;
      },
    });
    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: "noop",
        tools: [
          defineTool({
            name: "noop",
            description: "noop",
            parameters: Type.Object({}),
            replay: "safe",
            execute: async () => ({ output: [{ type: "text", text: "done" }] }),
          }),
        ],
      }),
    );
    const agent = (
      await DurableAgent.open({
        orbId: "orb",
        storage: new MemoryStorage(),
        models,
        registry,
        env: new NodeExecutionEnv({ cwd: "/tmp" }),
        checkoutCommit: "commit",
        instructions: "instruction",
        initialSettings,
      })
    )._unsafeUnwrap();
    const frames: ServerFrame[] = [];
    agent.subscribe((frame) => {
      frames.push(frame);
      if (
        frame.type === "runtime.event" &&
        frame.event.type === "output_patch" &&
        frame.event.patch.type === "replace"
      ) {
        if (frame.event.patch.text === "first round") releases[0].resolve();
        if (frame.event.patch.text === "second round") releases[1].resolve();
      }
    });
    try {
      await agent.deliver(input);
      await agent.waitForIdle();
      const patches = frames.flatMap((frame) =>
        frame.type === "runtime.event" && frame.event.type === "output_patch" ? [frame.event] : [],
      );
      const first = patches.filter(
        (patch) => patch.patch.type === "replace" && patch.patch.text === "first round",
      );
      const second = patches.filter(
        (patch) => patch.patch.type === "replace" && patch.patch.text === "second round",
      );
      expect(first.length).toBeGreaterThan(0);
      expect(second.length).toBeGreaterThan(0);
      const firstIds = new Set(first.map((patch) => patch.blockId));
      expect(second.some((patch) => firstIds.has(patch.blockId))).toBe(false);
      const saved = frames.filter((frame) => frame.type === "history.record");
      expect(saved[0]?.retiredBlockIds).toEqual([]);
      const assistant = saved.filter(
        (frame) => frame.record.type === "message" && frame.record.role === "assistant",
      );
      expect(new Set(assistant[0]?.retiredBlockIds)).toEqual(firstIds);
      expect(new Set(assistant[1]?.retiredBlockIds)).toEqual(
        new Set(second.map((patch) => patch.blockId)),
      );
    } finally {
      for (const release of releases) release.resolve();
      await agent.close();
    }
  });

  it("never replays an unsafe tool effect after suspension", async () => {
    const directory = await mkdtemp(join(tmpdir(), "durable-effect-"));
    const authority = new MemoryAgentPersistence();
    const entered = barrier();
    let effects = 0;
    const registry = () => {
      const value = createRegistry();
      value.install(
        defineExtension({
          name: "effect",
          tools: [
            defineTool({
              name: "effect",
              description: "effect",
              parameters: Type.Object({}),
              replay: "unsafe",
              execute: async (_args, _api, ctx) => {
                effects++;
                entered.resolve();
                await new Promise<void>((resolve) =>
                  ctx.abortSignal?.addEventListener("abort", () => resolve(), { once: true }),
                );
                return { output: [{ type: "text", text: "effect" }] };
              },
            }),
          ],
        }),
      );
      return value;
    };
    const firstModel = fauxProvider();
    firstModel.setResponses([
      fauxAssistantMessage(fauxToolCall("effect", {}, { id: "effect-call" }), {
        stopReason: "toolUse",
      }),
    ]);
    const models = createModels();
    models.setProvider(firstModel.provider);
    const first = (
      await DurableAgent.open({
        orbId: "orb",
        storage: (await authority.openOrb("orb", false))._unsafeUnwrap().storage,
        models,
        registry: registry(),
        env: new NodeExecutionEnv({ cwd: directory }),
        checkoutCommit: "commit",
        instructions: "instruction",
        initialSettings,
      })
    )._unsafeUnwrap({ withStackTrace: true });
    try {
      await first.deliver(input);
      await entered.promise;
      await first.close();
      const secondModel = fauxProvider();
      secondModel.setResponses([fauxAssistantMessage("done")]);
      const secondModels = createModels();
      secondModels.setProvider(secondModel.provider);
      const second = (
        await DurableAgent.open({
          orbId: "orb",
          storage: (await authority.openOrb("orb", true))._unsafeUnwrap().storage,
          models: secondModels,
          registry: registry(),
          env: new NodeExecutionEnv({ cwd: directory }),
          checkoutCommit: "commit",
          instructions: "instruction",
          initialSettings,
        })
      )._unsafeUnwrap({ withStackTrace: true });
      try {
        await second.waitForIdle();
        expect(effects).toBe(1);
        expect(JSON.stringify(second.snapshot()._unsafeUnwrap().records)).toContain("interrupted");
      } finally {
        await second.close();
      }
    } finally {
      await first.close();
      await authority.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

it("publishes a persisted Luna source for a child launched inside codemode", async () => {
  const { createDurableTools } = await import("./tools/index.ts");
  const tools = createDurableTools();
  const registry = createRegistry();
  registry.install(tools.extension);
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("codemode", {
        code: 'text(await tools.subagent({prompt:"PRIVATE_TASK_INPUT"}));',
      }),
      { stopReason: "toolUse" },
    ),
    ...Array(3).fill(
      async (
        request: Parameters<FauxResponseFactory>[0],
        options: Parameters<FauxResponseFactory>[1],
      ) => {
        const user = request.messages.find((message) => message.role === "user");
        if (JSON.stringify(user?.content).includes("PRIVATE_TASK_INPUT")) {
          await new Promise<void>((resolve) => {
            if (options?.signal?.aborted) resolve();
            else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return fauxAssistantMessage("", { stopReason: "aborted" });
        }
        return fauxAssistantMessage("parent finished");
      },
    ),
  ]);
  const agent = (
    await DurableAgent.open({
      orbId: "orb",
      storage: new MemoryStorage(),
      models,
      registry,
      env: new NodeExecutionEnv({ cwd: "/tmp" }),
      checkoutCommit: null,
      instructions: "PRIVATE_INSTRUCTIONS",
      initialSettings,
    })
  )._unsafeUnwrap();
  const sourcePublished = barrier();
  const children: import("@pi-orb/protocol").ActiveSubagent[] = [];
  const unsubscribe = agent.subscribe((frame) => {
    if (frame.type === "runtime.event" && frame.event.type === "subagents") {
      for (const child of frame.event.children) {
        if (child.taskRecordId) {
          children.push(child);
          sourcePublished.resolve();
        }
      }
    }
  });
  try {
    (await agent.deliver(input))._unsafeUnwrap();
    await sourcePublished.promise;
    const child = children[0];
    expect(child?.description).toBe(`Subagent ${child?.id}`);
    expect(JSON.stringify(children)).not.toContain("PRIVATE");
    const snapshot = agent.snapshot()._unsafeUnwrap();
    const source = snapshot.records.find((record) => record.id === child?.taskRecordId);
    expect(source).toMatchObject({ type: "event", subagentTask: { prompt: "PRIVATE_TASK_INPUT" } });
    expect(JSON.stringify(source)).not.toContain("PRIVATE_INSTRUCTIONS");
    expect(
      snapshot.records.filter((record) => record.type === "event" && record.subagentTask),
    ).toHaveLength(1);
  } finally {
    unsubscribe();
    await agent.close();
    await tools.close();
  }
});

it.each([
  { error: new Error("injected storage IO"), code: "unavailable" },
  {
    error: new StorageFailure("Owner revoked", {
      cause: { type: "authority_error", code: "stale_owner", message: "Owner revoked" },
    }),
    code: "stale_owner",
  },
])("invalidates the agent and records a durable edge on fatal $code", async ({ error, code }) => {
  const backend = new MemoryStorage();
  let fail = false;
  const storage = new Proxy(backend, {
    get(target, key) {
      if (key === "commit")
        return (...args: Parameters<Storage["commit"]>) =>
          fail ? Promise.reject(error) : target.commit(...args);
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const recorded = barrier();
  const released = barrier();
  const edges: { code: string; facts: Readonly<Record<string, string | number | boolean>> }[] = [];
  const frames: ServerFrame[] = [];
  let invalidated = false;
  const agent = (
    await DurableAgent.open({
      orbId: "orb",
      storage,
      models,
      registry: createRegistry(),
      env: new NodeExecutionEnv({ cwd: "/tmp" }),
      checkoutCommit: "commit",
      instructions: "",
      initialSettings,
      edge: (code, facts) => {
        edges.push({ code, facts });
        if (code === "harness.storage_failed") recorded.resolve();
        return okAsync(undefined);
      },
      closeResources: () => {
        released.resolve();
        return okAsync(undefined);
      },
    })
  )._unsafeUnwrap();
  agent.subscribe(
    (frame) => frames.push(frame),
    () => {
      invalidated = true;
    },
  );
  try {
    fail = true;
    const failed = (await agent.appendAlert("failure", "fail commit"))._unsafeUnwrapErr();
    expect(failed.retryable).toBe(false);
    if (code === "stale_owner") expect(failed.message).toBe("Owner revoked");
    expect(agent.accepting()).toBe(false);
    await recorded.promise;
    await released.promise;
    expect(invalidated).toBe(true);
    expect(agent.accepting()).toBe(false);
    expect(agent.health()).toMatchObject({ status: "failed" });
    expect(edges.filter((entry) => entry.code === "harness.storage_failed")).toEqual([
      { code: "harness.storage_failed", facts: { orbId: "orb", code } },
    ]);
    expect(frames).toContainEqual(
      expect.objectContaining({
        type: "server.error",
        error: expect.objectContaining({ code: "central_agent_storage_failed" }),
      }),
    );
  } finally {
    await agent.close();
  }
});

it.each([false, true])(
  "keeps native nested argument values private during live and final publication (error: %s)",
  async (isError) => {
    const secret = "PRIVATE_LIVE_NESTED_ARGUMENT_CANARY";
    const entered = barrier(),
      release = barrier();
    const storage = new MemoryStorage();
    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: "native-nested-privacy",
        tools: [
          defineTool({
            name: "inner",
            callers: ["tools"],
            description: "private nested input",
            parameters: Type.Object({ token: Type.String() }),
            execute: async (_args, api, ctx) => {
              api.output(secret);
              await api.details({ arguments: { token: secret } }, ctx);
              entered.resolve();
              await release.promise;
              return { output: [{ type: "text", text: "nested done" }] };
            },
          }),
          defineTool({
            name: "codemode",
            callers: ["model"],
            description: "parent",
            parameters: Type.Object({}),
            execute: async (_args, api, ctx) => {
              await api.executeTool("inner", { token: secret }, ctx, { key: "inner" });
              return {
                isError,
                output: [{ type: "text", text: "done" }],
                details: {
                  calls: [
                    {
                      id: 1,
                      name: "inner",
                      args: JSON.stringify({ token: secret }),
                      argumentKeys: ["token"],
                      status: isError ? "error" : "ok",
                    },
                  ],
                },
              };
            },
          }),
        ],
      }),
    );
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("codemode", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("finished"),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const agent = (
      await DurableAgent.open({
        orbId: "orb",
        storage,
        models,
        registry,
        env: new NodeExecutionEnv({ cwd: "/tmp" }),
        checkoutCommit: null,
        instructions: "",
        initialSettings,
      })
    )._unsafeUnwrap();
    const frames: ServerFrame[] = [];
    agent.subscribe((frame) => frames.push(frame));
    try {
      (await agent.deliver(input))._unsafeUnwrap();
      await entered.promise;
      // Read the native document without creating a second owning Session over this backend.
      const record = await storage.findDocument(
        {
          kind: LiveDoc.definition.kind,
          scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID },
        },
        "current",
        BACKGROUND_CONTEXT,
      );
      expect(
        JSON.stringify(
          (await storage.document(record!.id, "current", BACKGROUND_CONTEXT))?.value.nestedTools,
        ),
      ).toContain(secret);
      expect(JSON.stringify(agent.liveView())).not.toContain(secret);
      expect(JSON.stringify(frames)).not.toContain(secret);
      release.resolve();
      (await agent.waitForIdle())._unsafeUnwrap();
      expect(JSON.stringify(agent.snapshot()._unsafeUnwrap())).not.toContain(secret);
      expect(JSON.stringify(frames)).not.toContain(secret);
      const tasks = await storage.scanTasks({ kind: "pi.tool" }, 10, undefined, BACKGROUND_CONTEXT);
      expect(tasks.items.every((task) => task.version === 2)).toBe(true);
      expect(
        tasks.items.some(
          (task) =>
            typeof task.input === "object" &&
            task.input !== null &&
            "kind" in task.input &&
            task.input.kind === "nested",
        ),
      ).toBe(true);
    } finally {
      release.resolve();
      await agent.close();
    }
  },
);

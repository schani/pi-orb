import { EventEmitter } from "node:events";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { ServerFrame } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { expect, it } from "vitest";
import type { AgentPlane } from "../../domain/agent-ports.ts";
import { readLiveDisplayDetail } from "../../domain/display-detail.ts";
import { attachCentralLive } from "../../http/central-live.ts";
import { makeHarness, makeOrbRow } from "../../testkit/fixtures.ts";
import { DurableAgent } from "./agent.ts";

class Socket extends EventEmitter {
  readonly bufferedAmount = 0;
  readonly frames: ServerFrame[] = [];
  observe: (frame: ServerFrame) => void = () => undefined;
  send(text: string) {
    const frame = JSON.parse(text) as ServerFrame;
    this.frames.push(frame);
    this.observe(frame);
  }
  close() {
    this.emit("close");
  }
}

it("publishes reasoning headlines through live updates and reconnect without replacing full detail", async () => {
  const stream = createAssistantMessageEventStream();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider({
    ...faux.provider,
    streamSimple: () => {
      started();
      return stream;
    },
  });
  const agent = (
    await DurableAgent.open({
      orbId: "orb",
      storage: new MemoryStorage(),
      models,
      registry: createRegistry(),
      env: new NodeExecutionEnv({ cwd: "/tmp" }),
      checkoutCommit: "commit",
      instructions: "",
      initialSettings: {
        model: { provider: "faux", id: "faux-1" },
        thinkingLevel: "off",
      },
    })
  )._unsafeUnwrap();
  const sessionId = agent.snapshot()._unsafeUnwrap().session.id;
  const hello = JSON.stringify({
    v: 1,
    type: "client.hello",
    clientInstanceId: "browser",
    afterRecordId: null,
  });
  const first = new Socket();
  const reopened = new Socket();
  const detachFirst = attachCentralLive(first, agent, [hello]);
  let detachReopened: () => void = () => undefined;
  const thinking = "# Inspect files\n\nPRIVATE_REASONING_BODY";
  const appended = "\n\n**Choose fix**\n\nMORE_PRIVATE_REASONING";
  const message = (text: string) => fauxAssistantMessage([{ type: "thinking", thinking: text }]);
  const nextReasoning = (socket: Socket, text: string) =>
    new Promise<Extract<ServerFrame, { type: "runtime.event" }>>((resolve) => {
      socket.observe = (frame) => {
        if (
          frame.type === "runtime.event" &&
          frame.event.type === "output_patch" &&
          frame.event.blockType === "reasoning" &&
          agent.liveView()?.blocks.some((block) => block.text === text)
        ) {
          socket.observe = () => undefined;
          resolve(frame);
        }
      };
    });
  try {
    (
      await agent.deliver({
        baseUrl: "unused",
        messageId: "input",
        messageIds: ["input"],
        content: [{ type: "text", text: "question" }],
      })
    )._unsafeUnwrap();
    await ready;
    const initial = nextReasoning(first, thinking);
    stream.push({ type: "start", partial: message("") });
    stream.push({
      type: "thinking_delta",
      contentIndex: 0,
      delta: thinking,
      partial: message(thinking),
    });
    expect.soft((await initial).event).toMatchObject({
      headline: "Inspect files",
      patch: { type: "replace", text: "" },
    });
    detachFirst();
    detachReopened = attachCentralLive(reopened, agent, [hello]);
    expect(reopened.frames.at(-1)?.type).toBe("sync.completed");
    expect(
      reopened.frames.find(
        (frame) => frame.type === "runtime.event" && frame.event.type === "output_patch",
      ),
    ).toMatchObject({
      event: { headline: "Inspect files", patch: { type: "replace", text: "" } },
    });
    const updated = nextReasoning(reopened, thinking + appended);
    stream.push({
      type: "thinking_delta",
      contentIndex: 0,
      delta: appended,
      partial: message(thinking + appended),
    });
    expect.soft((await updated).event).toMatchObject({
      headline: "Inspect files · Choose fix",
      patch: { type: "replace", text: "" },
    });
    const live = agent.liveView();
    if (live === null) throw new Error("Held reasoning operation disappeared");
    const block = live.blocks.find((block) => block.blockType === "reasoning");
    if (block === undefined) throw new Error("Held reasoning block disappeared");
    expect(block.text).toBe(thinking + appended);
    expect.soft(block).toMatchObject({ contentIndex: 0 });
    const h = makeHarness();
    h.store.seedOrb({ ...makeOrbRow("orb", "project", "stopped"), harnessSessionId: sessionId });
    const deps = {
      ...h.deps,
      agentPlane: {
        placement: "central",
        session: () => agent,
      } as unknown as AgentPlane,
    };
    expect(
      (
        await readLiveDisplayDetail(new NoSimulationTask("reasoning detail", false), deps, {
          orbId: "orb",
          sessionId,
          operationId: live.operationId,
          blockId: block.blockId,
        })
      )._unsafeUnwrap().body,
    ).toEqual({ type: "reasoning", text: thinking + appended });
    expect(JSON.stringify([...first.frames, ...reopened.frames])).not.toContain(
      "PRIVATE_REASONING",
    );
    stream.push({ type: "done", reason: "stop", message: message(thinking + appended) });
    stream.end();
    await agent.waitForIdle();
    expect(agent.snapshot()._unsafeUnwrap().records).toContainEqual(
      expect.objectContaining({
        type: "message",
        role: "assistant",
        content: [{ type: "reasoning", text: thinking + appended }],
      }),
    );
  } finally {
    detachFirst();
    detachReopened();
    stream.end();
    await agent.close();
  }
});

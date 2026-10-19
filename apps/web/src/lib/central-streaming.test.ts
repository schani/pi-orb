import { EventEmitter } from "node:events";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { NoSimulationTask } from "determined";
import { okAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import { DurableAgentPlane } from "../../../control-plane/src/adapters/durable/manager.ts";
import { MemoryAgentPersistence } from "../../../control-plane/src/adapters/durable/memory-persistence.testkit.ts";
import { attachCentralLive } from "../../../control-plane/src/http/central-live.ts";
import { makeOrbRow } from "../../../control-plane/src/testkit/fixtures.ts";
import { openLiveConnection } from "./live.ts";

class BrowserSocket extends EventEmitter {
  bufferedAmount = 0;
  sent: string[] = [];
  closed = false;
  send(text: string) {
    this.sent.push(text);
  }
  close() {
    this.closed = true;
    this.emit("close");
  }
}

it("preserves the browser subscription across Stop and passive history, then streams fresh input", async () => {
  const models = createModels();
  const faux = fauxProvider();
  let streamed!: () => void;
  const streaming = new Promise<void>((resolve) => {
    streamed = resolve;
  });
  let finish!: () => void;
  const completion = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let settled!: () => void;
  const terminal = new Promise<void>((resolve) => {
    settled = resolve;
  });
  models.setProvider({
    ...faux.provider,
    streamSimple: () => {
      const message = fauxAssistantMessage("fresh answer");
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.push({ type: "text_delta", contentIndex: 0, delta: "fresh answer", partial: message });
      void completion.then(() => {
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
      });
      return stream;
    },
  });
  let orb = makeOrbRow("orb", "project", "running");
  let opens = 0;
  const plane = (
    await DurableAgentPlane.create({
      persistence: new MemoryAgentPersistence(),
      currentOrb: () => okAsync(orb),
      openContext: () => {
        opens++;
        return okAsync({
          resume: orb.stopReason !== "manual",
          models,
          registry: createRegistry(),
          env: new NodeExecutionEnv({ cwd: "/tmp" }),
          checkoutCommit: null,
          instructions: "test",
          initialSettings: { model: { provider: "faux", id: "faux-1" }, thinkingLevel: "off" },
        });
      },
    })
  )._unsafeUnwrap();
  const task = new NoSimulationTask("central-streaming", false);
  const context = { signal: new AbortController().signal };
  const original = orb;
  const sockets: BrowserSocket[] = [];
  let currentClient!: Client;
  const browserFrames: unknown[] = [];
  let cursor: string | null = null;
  let synchronized!: () => void;
  const sync = new Promise<void>((resolve) => {
    synchronized = resolve;
  });
  class Client {
    static OPEN = 1;
    readyState = 1;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    readonly server = new BrowserSocket();
    constructor() {
      currentClient = this;
      sockets.push(this.server);
      this.server.send = (text) => {
        this.server.sent.push(text);
        this.onmessage?.({ data: text });
      };
      this.server.on("close", () => {
        this.readyState = 3;
        this.onclose?.();
      });
      attachCentralLive(this.server, plane.session(original.id)!);
    }
    send(text: string) {
      this.server.emit("message", Buffer.from(text), false);
    }
    close() {
      this.server.close();
    }
  }
  vi.stubGlobal("WebSocket", Client);
  const browserEvents = new EventTarget();
  vi.stubGlobal("window", {
    addEventListener: browserEvents.addEventListener.bind(browserEvents),
    removeEventListener: browserEvents.removeEventListener.bind(browserEvents),
    location: { protocol: "http:", host: "test" },
    setTimeout: () => expect.fail("stable subscription must not reconnect"),
    clearTimeout: () => undefined,
  });
  let browser: ReturnType<typeof openLiveConnection> | null = null;
  try {
    (await plane.health(task, orb, context))._unsafeUnwrap();
    const handle = plane.session(orb.id)!;
    browser = openLiveConnection({
      orbId: orb.id,
      sessionId: handle.snapshot()._unsafeUnwrap().session.id,
      getAfterRecordId: () => cursor,
      getVisible: () => true,
      onRequestLost: () => expect.fail("no browser request was pending"),
      onFrame: (frame) => {
        browserFrames.push(frame);
        if (frame.type === "history.record") cursor = frame.record.id;
        if (frame.type === "sync.completed") synchronized();
        if (frame.type === "runtime.event" && frame.event.type === "output_patch") streamed();
        if (frame.type === "runtime.event" && frame.event.type === "operation_finished") settled();
      },
      onStatus: () => undefined,
    });
    currentClient.onopen?.();
    await sync;
    const live = currentClient.server;
    const sessionId = handle.snapshot()._unsafeUnwrap().session.id;
    (await plane.suspend(task, orb.id, context, 1))._unsafeUnwrap();
    orb = { ...orb, state: "stopped", stopReason: "manual", agentAdmissionVersion: 1 };
    expect((await plane.readSession(task, orb, context))._unsafeUnwrap()).toBe(handle);
    expect((await handle.readSnapshot!())._unsafeUnwrap().session.id).toBe(sessionId);
    expect(opens).toBe(1);
    expect(live.closed).toBe(false);
    orb = { ...original, agentAdmissionVersion: 2 };
    (await plane.health(task, orb, context))._unsafeUnwrap();
    expect(plane.session(orb.id)).toBe(handle);
    expect((await plane.health(task, original, context)).isErr()).toBe(true);
    (
      await plane.deliverMessage(
        task,
        orb,
        {
          baseUrl: "central",
          messageId: "fresh-message",
          messageIds: [],
          content: [{ type: "text", text: "fresh question" }],
        },
        context,
      )
    )._unsafeUnwrap();
    await streaming;
    expect(live.closed).toBe(false);
    expect(JSON.stringify(browserFrames)).toContain("fresh answer");
    expect(JSON.stringify(browserFrames)).toContain("output_patch");
    expect(JSON.stringify(browserFrames)).not.toContain("operation_finished");
    finish();
    await terminal;
    expect(sockets).toHaveLength(1);
    expect(live.closed).toBe(false);
    expect(live.sent.join("\n")).toContain("operation_finished");
    expect(opens).toBe(2);
  } finally {
    finish();
    browser?.dispose();
    for (const socket of sockets) socket.close();
    vi.unstubAllGlobals();
    await plane.close();
  }
});

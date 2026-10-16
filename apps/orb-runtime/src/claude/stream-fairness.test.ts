import { once } from "node:events";
import { createConnection, createServer, type Socket } from "node:net";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "vitest";
import { ComposedClaudeFixture, rootRequest, rootResult } from "../testkit/claude-composed.ts";

const start = {
  type: "stream_event",
  parent_tool_use_id: null,
  uuid: "block",
  session_id: "session",
  event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
} as unknown as SDKMessage;
const delta = {
  ...start,
  event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "." } },
} as unknown as SDKMessage;

async function admit(f: ComposedClaudeFixture, id = "inbox") {
  expect(
    (await f.agent.deliverInboxMessage(id, [id], [{ type: "text", text: "hello" }])).isOk(),
  ).toBe(true);
  const input = await f.query.input.next();
  if (input.done === true) throw new Error("native input ended");
  f.receipt(input.value);
}

async function finish(f: ComposedClaudeFixture) {
  const query = f.query;
  query.exit();
  query.endOutput();
  await f.agent.closeExtensions();
}

it("services socket I/O before the tail of an already-buffered SDK burst using the production yield", async () => {
  const f = new ComposedClaudeFixture(Promise.resolve(), {});
  const server = createServer();
  let peer: Socket | undefined;
  let client: Socket | undefined;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing TCP address");
    const accepted = once(server, "connection");
    client = createConnection(address.port, "127.0.0.1");
    const connected = once(client, "connect");
    [peer] = (await accepted) as [Socket];
    await connected;
    peer.pause();
    const readable = once(peer, "readable");
    client.write("probe");
    await readable;
    peer.pause();
    expect(peer.readableLength).toBeGreaterThan(0);
    expect((await f.attach()).isOk()).toBe(true);
    await admit(f);
    await f.query.enqueue(start);
    let patches = 0;
    let patchesAtRead = -1;
    let read: () => void = () => undefined;
    const received = new Promise<void>((resolve) => {
      read = resolve;
    });
    f.agent.subscribe((frame) => {
      if (frame.type === "runtime.event" && frame.event.type === "output_patch") {
        patches++;
        if (patches === 1) {
          peer?.once("data", () => {
            patchesAtRead = patches;
            read();
          });
          peer?.resume();
        }
      }
    });
    const burst = Array.from({ length: 256 }, () => f.query.enqueue(delta));
    await Promise.all([...burst, received]);
    expect(patches).toBe(256);
    expect(patchesAtRead).toBe(1);
  } finally {
    client?.destroy();
    peer?.destroy();
    server.close();
    await finish(f);
    f.dispose();
  }
});

it("stream events avoid history reads/fsyncs; meaningful messages, snapshots, duplicates and drains still flush", async () => {
  const f = new ComposedClaudeFixture();
  try {
    expect((await f.attach()).isOk()).toBe(true);
    await admit(f);
    await f.query.enqueue(rootRequest);
    const before = { ...f.historyIO };
    await f.query.enqueue(start);
    await Promise.all(Array.from({ length: 64 }, () => f.query.enqueue(delta)));
    expect({ ...f.historyIO }).toEqual(before);

    const flushes = async (action: () => unknown) => {
      const previous = { ...f.historyIO };
      await action();
      expect(f.historyIO.reads).toBeGreaterThan(previous.reads);
      expect(f.historyIO.syncs).toBeGreaterThan(previous.syncs);
    };
    await flushes(() => f.query.enqueue(rootRequest));
    await flushes(() =>
      f.query.enqueue({
        type: "user",
        uuid: "echo",
        session_id: "session",
        parent_tool_use_id: null,
        message: { role: "user", content: "hello" },
      } as unknown as SDKMessage),
    );
    await flushes(() => f.agent.appendAlert({ v: 1, requestId: "alert", message: "diagnostic" }));
    await flushes(() => f.agent.snapshot());
    await flushes(() =>
      f.agent.deliverInboxMessage("inbox", ["inbox"], [{ type: "text", text: "hello" }]),
    );
    f.append({
      type: "assistant",
      uuid: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: ".".repeat(64) }] },
    });
    await flushes(() =>
      f.query.enqueue({
        type: "assistant",
        uuid: "assistant",
        session_id: "session",
        parent_tool_use_id: null,
        message: { role: "assistant", content: [{ type: "text", text: ".".repeat(64) }] },
      } as unknown as SDKMessage),
    );
    await flushes(() => f.query.enqueue(rootResult));
    await flushes(() => finish(f));
    expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
  } finally {
    await finish(f);
    f.dispose();
  }
});

it("yields even when diagnostic persistence takes the consume-loop continue path", async () => {
  let yields = 0;
  const f = new ComposedClaudeFixture(Promise.resolve(), {
    yieldMessage: async () => {
      yields++;
    },
  });
  try {
    expect((await f.attach()).isOk()).toBe(true);
    await admit(f);
    f.failCommit = true;
    const error = {
      ...rootResult,
      subtype: "error_during_execution",
      is_error: true,
      errors: ["injected native error"],
    } as unknown as SDKMessage;
    await Promise.all(Array.from({ length: 4 }, () => f.query.enqueue(error)));
    expect(yields).toBe(4);
    expect(f.agent.getHealth()).toMatchObject({
      status: "failed",
      error: { code: "history_unavailable" },
    });
  } finally {
    f.failCommit = false;
    await finish(f);
    f.dispose();
  }
});

it("abort and shutdown wait for yielded stdout; busy input cannot replace its query", async () => {
  let pause = false;
  let arrived: () => void = () => undefined;
  let release: () => void = () => undefined;
  const waiting = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = new ComposedClaudeFixture(Promise.resolve(), {
    yieldMessage: async () => {
      if (!pause) return;
      pause = false;
      arrived();
      await resumed;
    },
  });
  try {
    expect((await f.attach()).isOk()).toBe(true);
    await admit(f);
    const old = f.query;
    pause = true;
    const consumed = old.enqueue(rootResult);
    await waiting;
    const aborted = f.agent.abortOperation();
    let closed = false;
    const closing = f.agent.closeExtensions().then(() => {
      closed = true;
    });
    expect(
      (
        await f.agent.deliverInboxMessage("busy", ["busy"], [{ type: "text", text: "later" }])
      ).isErr(),
    ).toBe(true);
    old.exit();
    old.endOutput();
    expect(closed).toBe(false);
    expect(f.queries).toHaveLength(2);
    release();
    await consumed;
    await closing;
    expect((await aborted).isOk()).toBe(true);
    expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
    await admit(f, "new");
    const operationId = f.agent.liveView()?.operationId;
    expect(f.queries).toHaveLength(3);
    expect(f.query).not.toBe(old);
    expect(await old.enqueue(delta)).toBe(false);
    expect(f.agent.liveView()).toMatchObject({ operationId, blocks: [] });
    expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "busy" });
  } finally {
    release();
    await finish(f);
    f.dispose();
  }
});

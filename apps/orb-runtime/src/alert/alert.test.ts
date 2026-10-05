import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { okAsync } from "neverthrow";
import { afterEach, expect, it } from "vitest";
import { buildRuntimeServer } from "../http/server.ts";
import { PiOrbAgent, type PiSession } from "../pi/agent.ts";
import { createPersistentSession } from "../pi/settings-persistence.ts";
import type { TerminalManager } from "../terminal/manager.ts";
import { MemoryIdleStopFence } from "../testkit/idle-stop-fence.ts";
import { sendAlert } from "./command.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const token = "test-secret";
function fixture(busy = true) {
  const dir = mkdtempSync(join(tmpdir(), "orb-alert-"));
  dirs.push(dir);
  const manager = createPersistentSession(dir, join(dir, "sessions"))._unsafeUnwrap();
  const agent = new PiOrbAgent({
    orbId: "orb",
    repositoryUrl: "https://example.com/repo",
    workDir: dir,
    skillsDir: null,
    broker: null,
    executionId: "host",
    idleStopFence: new MemoryIdleStopFence(),
  });
  agent.attachSession(
    {
      isIdle: !busy,
      subscribe: () => () => undefined,
      sendUserMessage: () => new Promise(() => {}),
    } as unknown as PiSession,
    manager,
    { summarize: () => okAsync("") },
  );
  if (busy) {
    void agent.submitMessage([], "running-agent");
  }
  const app = buildRuntimeServer(
    agent,
    { closeAll: () => undefined } as unknown as TerminalManager,
    token,
  );
  const send = (message: string, requestId: string, authorization = `Bearer ${token}`) =>
    app.inject({
      method: "POST",
      url: "/v1/alert",
      headers: { authorization },
      payload: { v: 1, message, requestId },
    });
  return { dir, manager, agent, app, send };
}

it("persists a first-turn alert while busy, publishes once, and deduplicates after reopen", async () => {
  const { dir, manager, agent, app, send } = fixture();
  try {
    const published: string[] = [];
    agent.subscribe((frame) => {
      if (frame.type === "history.record") published.push(frame.record.id);
    });
    expect(agent.getHealth()).toMatchObject({ activity: "busy" });
    const first = await send("<b>pay attention</b>\nnow", "request-1");
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ v: 1, duplicate: false });
    const id = first.json().id as string;
    expect(published).toContain(id);
    expect(
      agent
        .replicationSnapshot()
        ._unsafeUnwrap()
        .records.find((r) => r.id === id),
    ).toMatchObject({
      type: "event",
      alert: { message: "<b>pay attention</b>\nnow", requestId: "request-1" },
    });
    expect((await send("<b>pay attention</b>\nnow", "request-1")).json()).toEqual({
      v: 1,
      id,
      duplicate: true,
    });
    expect(published.filter((record) => record === id)).toHaveLength(1);
    const file = manager.getSessionFile();
    expect(file).toBeTruthy();
    if (!file) throw new Error("missing persistent session file");
    const reopened = SessionManager.open(file, join(dir, "sessions"), dir);
    expect(reopened.getEntries().find((entry) => entry.id === id)).toMatchObject({
      type: "custom",
      customType: "pi-orb.alert",
      data: { message: "<b>pay attention</b>\nnow", requestId: "request-1" },
    });
    expect(reopened.buildContextEntries().some((entry) => entry.id === id)).toBe(true);
    const { sessionEntryToContextMessages } = await import("@earendil-works/pi-coding-agent");
    expect(
      reopened
        .buildContextEntries()
        .flatMap(sessionEntryToContextMessages)
        .some((message) => "customType" in message && message.customType === "pi-orb.alert"),
    ).toBe(false);
    expect((await send("changed", "request-1")).statusCode).toBe(409);
    const restarted = new PiOrbAgent({
      orbId: "orb",
      repositoryUrl: "https://example.com/repo",
      workDir: dir,
      skillsDir: null,
      broker: null,
      executionId: "host",
      idleStopFence: new MemoryIdleStopFence(),
    });
    restarted.attachSession(
      { isIdle: true, subscribe: () => () => undefined } as unknown as PiSession,
      reopened,
      { summarize: () => okAsync("") },
    );
    expect(
      restarted
        .appendAlert({ v: 1, message: "<b>pay attention</b>\nnow", requestId: "request-1" })
        ._unsafeUnwrap(),
    ).toEqual({ v: 1, id, duplicate: true });
  } finally {
    await app.close();
  }
});

it("sends an authenticated alert over the real loopback listener", async () => {
  const { agent, app } = fixture(false);
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("missing listener");
    const reply = await sendAlert(
      { message: "real HTTP", requestId: "loopback-id" },
      { token, port: address.port },
    );
    expect(reply._unsafeUnwrap()).toMatchObject({ duplicate: false });
    expect(agent.replicationSnapshot()._unsafeUnwrap().records).toContainEqual(
      expect.objectContaining({
        id: reply._unsafeUnwrap().id,
        alert: { message: "real HTTP", requestId: "loopback-id" },
      }),
    );
  } finally {
    await app.close();
  }
});

it("CLI can replay the same identity after a lost successful response", async () => {
  const { agent, app } = fixture();
  try {
    let loseResponse = true;
    const transport = async (
      _url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const reply = await app.inject({
        method: "POST",
        url: "/v1/alert",
        headers: {
          authorization: (init?.headers as Record<string, string>)?.authorization,
          "content-type": "application/json",
        },
        payload: init?.body as string,
      });
      if (loseResponse) {
        loseResponse = false;
        throw new Error("response lost");
      }
      return new Response(reply.body, { status: reply.statusCode });
    };
    const input = { message: "heads up", requestId: "stable-identity" };
    expect(
      (
        await sendAlert(input, { token, port: 8080, fetch: transport as typeof fetch })
      )._unsafeUnwrapErr(),
    ).toMatchObject({ code: "unknown_outcome", requestId: "stable-identity" });
    const second = await sendAlert(input, { token, port: 8080, fetch: transport as typeof fetch });
    expect(second._unsafeUnwrap()).toMatchObject({ duplicate: true });
    expect(
      agent
        .snapshot()
        ._unsafeUnwrap()
        .records.filter(
          (record) => record.type === "event" && record.alert?.requestId === input.requestId,
        ),
    ).toHaveLength(1);
  } finally {
    await app.close();
  }
});

it("accepts maximum-length escaped text through the HTTP byte limit", async () => {
  const { app, send } = fixture(false);
  try {
    const message = "\u0001".repeat(4096);
    const reply = await send(message, "r".repeat(128));
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ duplicate: false });
    const unicode = await send("🔔".repeat(2048), "emoji-id");
    expect(unicode.statusCode).toBe(200);
  } finally {
    await app.close();
  }
});

it("reports a synchronous transport throw as an unknown outcome with replay identity", async () => {
  const input = { message: "heads up", requestId: "stable-id" };
  const transport = (() => {
    throw new Error("fetch failed before returning a promise");
  }) as typeof fetch;
  const result = await sendAlert(input, { token, port: 8080, fetch: transport });
  expect(result._unsafeUnwrapErr()).toMatchObject({
    code: "unknown_outcome",
    requestId: "stable-id",
  });
});

it("fails closed without publishing when fsync cannot confirm persistence", async () => {
  const { agent, manager, app, send } = fixture(false);
  try {
    manager.getSessionFile = () => "/does-not-exist/orb-alert.jsonl";
    const reply = await send("uncertain", "uncertain-id");
    expect(reply.statusCode).toBe(503);
    expect(agent.getHealth()).toMatchObject({ status: "failed" });
    expect((await send("next", "next-id")).statusCode).toBe(503);
  } finally {
    await app.close();
  }
});

it("rejects alerts during shutdown", async () => {
  const { agent, app, send } = fixture(false);
  try {
    agent.shutdownHooks();
    expect((await send("late", "late-shutdown")).statusCode).toBe(503);
  } finally {
    await app.close();
  }
});

it("rejects alerts after write admission closes", async () => {
  const { agent, app, send } = fixture(false);
  try {
    expect(agent.prepareIdleStop()._unsafeUnwrap()).toBe(true);
    expect((await send("late", "late-id")).statusCode).toBe(503);
  } finally {
    await app.close();
  }
});

it("rejects missing auth and malformed inputs", async () => {
  const { agent, app, send } = fixture();
  try {
    expect((await send("hello", "r", "")).statusCode).toBe(401);
    expect((await send(" ", "r")).statusCode).toBe(400);
    expect((await send("x".repeat(4097), "r")).statusCode).toBe(400);
    expect((await send("hi", "r")).statusCode).toBe(200);
    expect(agent.getHealth()).toMatchObject({ activity: "busy" });
  } finally {
    await app.close();
  }
});

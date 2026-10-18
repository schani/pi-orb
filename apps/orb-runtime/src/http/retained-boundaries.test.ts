import { expect, it, vi } from "vitest";
import type { TerminalManager } from "../terminal/manager.ts";
import { ComposedClaudeFixture } from "../testkit/claude-composed.ts";
import { buildRuntimeServer } from "./server.ts";

it("serves Claude history and session-scoped image details without exposing private bytes", async () => {
  const f = new ComposedClaudeFixture();
  f.append({
    type: "user",
    uuid: "image",
    timestamp: f.state.timestamp,
    message: {
      role: "user",
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: Buffer.from("PRIVATE_IMAGE").toString("base64"),
          },
        },
      ],
    },
  });
  const app = buildRuntimeServer(f.agent, {
    closeAll: () => undefined,
  } as unknown as TerminalManager);
  try {
    expect((await f.attach()).isOk()).toBe(true);
    const history = await app.inject({ url: "/v1/history" });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toMatchObject({ records: [{ id: "image" }], headId: "image" });
    const snapshot = vi.spyOn(f.agent, "snapshot");
    const key = "image:0";
    const detailPath = `/v1/details/image/${key}`;
    const imagePath = `/v1/images/image/${key}/0`;
    for (const path of [detailPath, imagePath]) {
      expect((await app.inject({ url: path })).statusCode).toBe(409);
      expect((await app.inject({ url: `${path}?sessionId=wrong` })).statusCode).toBe(409);
    }
    const sessionId = f.agent.sessionId();
    const detail = await app.inject({ url: `${detailPath}?sessionId=${sessionId}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      state: "committed",
      body: { type: "image", imageRef: `${key}:0` },
    });
    expect(detail.body).not.toContain(Buffer.from("PRIVATE_IMAGE").toString("base64"));
    const image = await app.inject({ url: `${imagePath}?sessionId=${sessionId}` });
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toContain("image/png");
    expect(image.rawPayload.toString()).toBe("PRIVATE_IMAGE");
    expect(snapshot).not.toHaveBeenCalled();
  } finally {
    await app.close();
    f.dispose();
  }
});

it("authenticates and deduplicates Claude alerts before fencing late work for idle stop", async () => {
  const f = new ComposedClaudeFixture();
  const app = buildRuntimeServer(
    f.agent,
    { closeAll: () => undefined } as unknown as TerminalManager,
    "secret",
  );
  try {
    expect((await f.attach()).isOk()).toBe(true);
    const initialQueries = f.queries.length;
    const send = (token: string, message = "attention") =>
      app.inject({
        method: "POST",
        url: "/v1/alert",
        headers: { authorization: `Bearer ${token}` },
        payload: { v: 1, requestId: "alert", message },
      });
    expect((await send("wrong")).statusCode).toBe(401);
    const first = await send("secret");
    expect(first.statusCode).toBe(200);
    const id = first.json().id;
    expect(first.json()).toMatchObject({ duplicate: false });
    expect((await send("secret")).json()).toEqual({ v: 1, id, duplicate: true });
    expect((await send("secret", "different")).statusCode).toBe(409);
    expect(
      f.agent
        .replicationSnapshot()
        ._unsafeUnwrap()
        .records.filter((record) => record.id === id),
    ).toMatchObject([
      {
        type: "event",
        eventType: "pi-orb.alert",
        content: [{ type: "text", text: "attention" }],
        overflow: { message: "attention", requestId: "alert" },
      },
    ]);
    const stop = await app.inject({
      method: "POST",
      url: "/v1/prepare-idle-stop",
      payload: { v: 1 },
    });
    expect(stop.json()).toEqual({ v: 1, prepared: true });
    expect(f.agent.gateView().acceptingWork).toBe(false);
    expect((await send("secret")).statusCode).toBe(503);
    const late = await app.inject({
      method: "PUT",
      url: "/v1/messages/late",
      payload: {
        v: 1,
        messageId: "late",
        messageIds: ["late"],
        content: [{ type: "text", text: "must not execute" }],
      },
    });
    expect(late.statusCode).toBe(503);
    expect(f.queries).toHaveLength(initialQueries);
    expect((await app.inject({ url: "/v1/history" })).statusCode).toBe(200);
  } finally {
    await app.close();
    f.dispose();
  }
});

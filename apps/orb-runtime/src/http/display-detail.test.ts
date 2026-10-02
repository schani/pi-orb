import { SessionManager } from "@earendil-works/pi-coding-agent";
import { okAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import { PiOrbAgent, type PiSession } from "../pi/agent.ts";
import type { TerminalManager } from "../terminal/manager.ts";
import { MemoryIdleStopFence } from "../testkit/idle-stop-fence.ts";
import { buildRuntimeServer } from "./server.ts";

it("reads one indexed session entry per detail without scanning or mapping the transcript", async () => {
  const agent = new PiOrbAgent({
    orbId: "test",
    repositoryUrl: "https://example.com/repo",
    workDir: "/unused",
    skillsDir: null,
    broker: null,
    executionId: "test-host",
    idleStopFence: new MemoryIdleStopFence(),
  });
  const manager = SessionManager.inMemory("/unused");
  for (let i = 0; i < 500; i++)
    manager.appendMessage({
      role: "user",
      content: `SECRET-${i}-${"x".repeat(2000)}`,
      timestamp: i,
    });
  manager.appendMessage({
    role: "user",
    content: [
      { type: "image", data: Buffer.from("target").toString("base64"), mimeType: "image/png" },
    ],
    timestamp: 501,
  });
  agent.attachSession(
    { isIdle: true, subscribe: () => () => undefined } as unknown as PiSession,
    manager,
    { summarize: () => okAsync("") },
  );
  const target = manager.getEntries().at(-1);
  if (target === undefined) throw new Error("missing fixture entry");
  const allEntries = vi.spyOn(manager, "getEntries");
  const snapshot = vi.spyOn(agent, "snapshot");
  const app = buildRuntimeServer(agent, {
    closeAll: () => undefined,
  } as unknown as TerminalManager);
  try {
    await app.ready();
    allEntries.mockClear();
    snapshot.mockClear();
    const response = await app.inject({
      method: "GET",
      url: `/v1/details/${target.id}/${target.id}:0?sessionId=${agent.sessionId()}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      body: { type: "image", imageRef: `${target.id}:0:0` },
    });
    expect(snapshot).not.toHaveBeenCalled();
    expect(allEntries).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it("authenticates committed detail and image against session before serving bytes", async () => {
  const agent = new PiOrbAgent({
    orbId: "test",
    repositoryUrl: "https://example.com/repo",
    workDir: "/unused",
    skillsDir: null,
    broker: null,
    executionId: "test-host",
    idleStopFence: new MemoryIdleStopFence(),
  });
  const manager = SessionManager.inMemory("/unused");
  manager.appendMessage({
    role: "user",
    content: [
      {
        type: "image",
        data: Buffer.from("IMAGE_SECRET").toString("base64"),
        mimeType: "image/png",
      },
    ],
    timestamp: 1,
  });
  agent.attachSession(
    { isIdle: true, subscribe: () => () => undefined } as unknown as PiSession,
    manager,
    { summarize: () => okAsync("") },
  );
  const app = buildRuntimeServer(agent, {
    closeAll: () => undefined,
  } as unknown as TerminalManager);
  try {
    const record = agent.snapshot()._unsafeUnwrap().records[0];
    expect(record).toBeDefined();
    if (record === undefined) return;
    const key = `${record.id}:0`;
    const path = `/v1/images/${record.id}/${key}/0`;
    expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(409);
    expect(
      (await app.inject({ method: "GET", url: `${path}?sessionId=old-session` })).statusCode,
    ).toBe(409);
    const sessionId = agent.sessionId();
    expect(sessionId).not.toBeNull();
    const image = await app.inject({ method: "GET", url: `${path}?sessionId=${sessionId}` });
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toContain("image/png");
    expect(image.rawPayload.toString()).toBe("IMAGE_SECRET");
    const detail = await app.inject({
      method: "GET",
      url: `/v1/details/${record.id}/${key}?sessionId=${sessionId}`,
    });
    expect(detail.json()).toMatchObject({
      sessionId,
      recordId: record.id,
      detailKey: key,
      state: "committed",
      body: { type: "image", imageRef: `${key}:0` },
    });
    expect(detail.body).not.toContain("IMAGE_SECRET");
  } finally {
    await app.close();
  }
});

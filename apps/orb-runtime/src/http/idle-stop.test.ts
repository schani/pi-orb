import { SessionManager } from "@earendil-works/pi-coding-agent";
import { okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { PiOrbAgent, type PiSession } from "../pi/agent.ts";
import type { TerminalManager } from "../terminal/manager.ts";
import { MemoryIdleStopFence } from "../testkit/idle-stop-fence.ts";
import { buildRuntimeServer } from "./server.ts";

it("fences idle admission before the final pull, but refuses to fence child-only work", async () => {
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
  agent.attachSession(
    { isIdle: true, subscribe: () => () => undefined } as unknown as PiSession,
    manager,
    { summarize: () => okAsync("") },
  );
  const app = buildRuntimeServer(agent, {
    closeAll: () => undefined,
  } as unknown as TerminalManager);
  try {
    expect((await app.inject({ method: "POST", url: "/v1/prepare-idle-stop" })).statusCode).toBe(
      400,
    );
    expect(agent.gateView().acceptingWork).toBe(true);
    const child = agent.admitSubagent("leaf")._unsafeUnwrap();
    const prepare = () =>
      app.inject({ method: "POST", url: "/v1/prepare-idle-stop", payload: { v: 1 } });
    expect((await prepare()).json()).toEqual({ v: 1, prepared: false });
    expect(agent.gateView().acceptingWork).toBe(true);
    manager.appendCustomEntry("subagents:record", { id: "leaf", status: "completed" });
    agent.releaseSubagent(child);
    expect((await prepare()).json()).toEqual({ v: 1, prepared: true });
    expect((await prepare()).json()).toEqual({ v: 1, prepared: true });
    expect(agent.gateView().acceptingWork).toBe(false);
    const history = await app.inject({ method: "GET", url: "/v1/history" });
    expect(history.statusCode).toBe(200);
    // In-memory SDK entries are not replicated as durable records. The
    // independent fence also protects an empty/unflushed real session.
    expect(history.json().records).toEqual([]);
    expect(JSON.stringify(manager.getEntries())).toContain("pi-orb.idle-stop-prepared");
    const rejected = await app.inject({
      method: "PUT",
      url: "/v1/messages/late",
      payload: {
        v: 1,
        messageId: "late",
        messageIds: ["late"],
        content: [{ type: "text", text: "must not execute" }],
      },
    });
    expect(rejected.statusCode).toBe(503);
    expect(rejected.json()).toMatchObject({
      error: { code: "message_unavailable", retryable: true },
    });
    expect(JSON.stringify(manager.getEntries())).not.toContain("must not execute");
  } finally {
    await app.close();
  }
});

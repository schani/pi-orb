import { SessionManager } from "@earendil-works/pi-coding-agent";
import { okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { MemoryIdleStopFence } from "../testkit/idle-stop-fence.ts";
import { PiOrbAgent, type PiSession } from "./agent.ts";

it("Pi reasoning updates retain active HTTP body without emitting token-by-token browser frames", () => {
  const agent = new PiOrbAgent({
    orbId: "test",
    repositoryUrl: "https://example.com/repo",
    workDir: "/unused",
    skillsDir: null,
    broker: null,
    executionId: "test",
    idleStopFence: new MemoryIdleStopFence(),
  });
  agent.attachSession(
    { isIdle: true, subscribe: () => () => undefined } as unknown as PiSession,
    SessionManager.inMemory("/unused"),
    { summarize: () => okAsync("") },
  );
  const frames: unknown[] = [];
  const unsubscribe = agent.subscribe((frame) => frames.push(frame));
  agent["onAgentEvent"]({ type: "agent_start" } as Parameters<(typeof agent)["onAgentEvent"]>[0]);
  const operationId = agent.liveView()?.operationId;
  expect(operationId).toBeDefined();
  for (let i = 1; i <= 50; i++) {
    agent["onAgentEvent"]({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "thinking", thinking: `HIDDEN-${i}` }] },
    } as Parameters<(typeof agent)["onAgentEvent"]>[0]);
  }
  const detail = agent.readLiveDisplayDetail(operationId ?? "", `${operationId}-0-0`);
  expect(detail).toMatchObject({
    state: "running",
    body: { type: "reasoning", text: "HIDDEN-50" },
  });
  const serialized = JSON.stringify(frames);
  expect(serialized).not.toContain("HIDDEN-");
  expect(
    frames.filter(
      (frame) =>
        typeof frame === "object" &&
        frame !== null &&
        "type" in frame &&
        frame.type === "runtime.event" &&
        "event" in frame &&
        typeof frame.event === "object" &&
        frame.event !== null &&
        "type" in frame.event &&
        frame.event.type === "output_patch",
    ),
  ).toHaveLength(1);
  unsubscribe();
});

it("Pi publishes only changed compact reasoning headlines, including removal and redaction", () => {
  const agent = new PiOrbAgent({
    orbId: "test",
    repositoryUrl: "https://example.com/repo",
    workDir: "/unused",
    skillsDir: null,
    broker: null,
    executionId: "test",
    idleStopFence: new MemoryIdleStopFence(),
  });
  agent.attachSession(
    { isIdle: true, subscribe: () => () => undefined } as unknown as PiSession,
    SessionManager.inMemory("/unused"),
    { summarize: () => okAsync("") },
  );
  const frames: unknown[] = [];
  agent.subscribe((frame) => frames.push(frame));
  const send = (thinking: string, redacted = false) =>
    agent["onAgentEvent"]({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "thinking", thinking, redacted }] },
    } as Parameters<(typeof agent)["onAgentEvent"]>[0]);
  agent["onAgentEvent"]({ type: "agent_start" } as Parameters<(typeof agent)["onAgentEvent"]>[0]);
  send("# Inspect\n\nPRIVATE_BODY");
  send("# Inspect\n\nPRIVATE_BODY grows");
  send("# Inspect\n\nPRIVATE_BODY\n\n**Fix**");
  send("PRIVATE_BODY");
  send("# REDACTED_HEADING", true);
  send("# Visible");
  send("# Visible", true);
  const events = (frames as import("@pi-orb/protocol").ServerFrame[]).flatMap((frame) =>
    frame.type === "runtime.event" && frame.event.type === "output_patch" ? [frame.event] : [],
  );
  expect(events.map((event) => event.headline)).toEqual([
    "Inspect",
    "Inspect · Fix",
    "",
    "Visible",
    "",
  ]);
  expect(events.every((event) => event.patch.type === "replace" && event.patch.text === "")).toBe(
    true,
  );
  expect(JSON.stringify(frames)).not.toContain("PRIVATE_BODY");
  expect(JSON.stringify(frames)).not.toContain("REDACTED_HEADING");
  expect(agent.liveView()?.blocks[0]?.redacted).toBe(true);
});

it.each(["codemode", "bash"])(
  "Pi publishes bounded public %s code but ignores child calls",
  (toolName) => {
    const agent = new PiOrbAgent({
      orbId: "test",
      repositoryUrl: "https://example.com/repo",
      workDir: "/unused",
      skillsDir: null,
      broker: null,
      executionId: "test",
      idleStopFence: new MemoryIdleStopFence(),
    });
    agent.attachSession(
      { isIdle: true, subscribe: () => () => undefined } as unknown as PiSession,
      SessionManager.inMemory("/unused"),
      { summarize: () => okAsync("") },
    );
    const frames: unknown[] = [];
    agent.subscribe((frame) => frames.push(frame));
    agent["onAgentEvent"]({ type: "agent_start" } as Parameters<(typeof agent)["onAgentEvent"]>[0]);
    const code = `  first\n${"😀".repeat(400)}`;
    const args = { [toolName === "bash" ? "command" : "code"]: code, token: "SECRET_AUTH" };
    agent["onAgentEvent"]({ type: "tool_execution_start", toolCallId: "root", toolName, args });
    agent["onAgentEvent"]({
      type: "tool_execution_start",
      toolCallId: "child",
      parentToolCallId: "root",
      toolName,
      args: { code: "SECRET_CHILD", command: "SECRET_CHILD" },
    });
    const live = agent.liveView();
    expect(live?.tools).toHaveLength(1);
    const projected = live?.tools[0] as { code?: string };
    expect(projected.code).toContain("  first\n");
    expect(Buffer.byteLength(projected.code ?? "")).toBeLessThanOrEqual(1024);
    expect(projected.code).not.toContain("�");
    expect(JSON.stringify(frames)).not.toContain("SECRET");
  },
);

it("Pi tool progress remains HTTP-only and retires when the operation finishes", () => {
  const agent = new PiOrbAgent({
    orbId: "test",
    repositoryUrl: "https://example.com/repo",
    workDir: "/unused",
    skillsDir: null,
    broker: null,
    executionId: "test",
    idleStopFence: new MemoryIdleStopFence(),
  });
  agent.attachSession(
    { isIdle: true, subscribe: () => () => undefined } as unknown as PiSession,
    SessionManager.inMemory("/unused"),
    { summarize: () => okAsync("") },
  );
  const frames: unknown[] = [];
  agent.subscribe((frame) => frames.push(frame));
  agent["onAgentEvent"]({ type: "agent_start" } as Parameters<(typeof agent)["onAgentEvent"]>[0]);
  const operationId = agent.liveView()?.operationId ?? "";
  agent["onAgentEvent"]({
    type: "tool_execution_start",
    toolCallId: "call",
    toolName: "bash",
    args: { command: "echo visible", hidden: "HIDDEN_ARG" },
  });
  agent["onAgentEvent"]({
    type: "tool_execution_update",
    toolCallId: "call",
    toolName: "bash",
    args: {},
    partialResult: { content: [{ type: "text", text: "HIDDEN_OUTPUT" }] },
  });
  expect(agent.readLiveDisplayDetail(operationId, "call")).toMatchObject({
    state: "running",
    body: { type: "tool_result", content: [{ type: "text", text: "HIDDEN_OUTPUT" }] },
  });
  expect(agent.liveView()?.tools[0]).toMatchObject({ code: "echo visible" });
  expect(frames).toContainEqual(
    expect.objectContaining({
      type: "runtime.event",
      event: expect.objectContaining({ type: "tool_state", code: "echo visible" }),
    }),
  );
  expect(JSON.stringify(frames)).not.toContain("HIDDEN_OUTPUT");
  expect(JSON.stringify(frames)).not.toContain("HIDDEN_ARG");
  agent["onAgentEvent"]({
    type: "tool_execution_end",
    toolCallId: "call",
    toolName: "bash",
    result: { content: [{ type: "text", text: "FINAL_OUTPUT" }] },
    isError: false,
  });
  expect(agent.readLiveDisplayDetail(operationId, "call")).toMatchObject({
    state: "completed",
    body: { content: [{ text: "FINAL_OUTPUT" }] },
  });
  expect(agent.liveView()?.tools[0]).toMatchObject({ code: "echo visible" });
  agent["finishAgentOperation"](operationId, "completed");
  expect(agent.readLiveDisplayDetail(operationId, "call").state).toBe("unavailable");
});

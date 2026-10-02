import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { RuntimeEvent } from "@pi-orb/protocol";
import { okAsync } from "neverthrow";
import { expect, it } from "vitest";
import type { TurnSummarizer } from "../domain/turn-summary.ts";
import { PiOrbAgent, type PiSession, type PiSessionManager } from "./agent.ts";

it("publishes only model-issued tool states, not codemode's nested SDK executions", () => {
  let emit!: (event: AgentSessionEvent) => void;
  const session = {
    isIdle: true,
    subscribe: (listener: (event: AgentSessionEvent) => void) => {
      emit = listener;
      return () => undefined;
    },
  } as PiSession;
  const manager = {
    getEntries: () => [],
    getLeafId: () => null,
    getHeader: () => ({ id: "session-under-test" }),
    getSessionId: () => "session-under-test",
    getSessionFile: () => undefined,
    buildContextEntries: () => [],
    appendCustomEntry: () => "baseline",
  } as unknown as PiSessionManager;
  const summarizer: TurnSummarizer = { summarize: () => okAsync("") };
  const agent = new PiOrbAgent({
    skillsDir: null,
    orbId: "orb-under-test",
    repositoryUrl: "https://example.com/repo.git",
    workDir: "/nonexistent",
    broker: null,
    turnSummarizer: summarizer,
  });
  const states: Extract<RuntimeEvent, { type: "tool_state" }>[] = [];
  agent.subscribe((frame) => {
    if (frame.type === "runtime.event" && frame.event.type === "tool_state")
      states.push(frame.event);
  });
  agent.attachSession(session, manager, summarizer);
  emit({ type: "agent_start" });
  emit({
    type: "tool_execution_start",
    toolCallId: "codemode-1",
    toolName: "codemode",
    args: { code: "await tools.mcp__datadog__search_datadog_logs({query: 'status:error'})" },
  });
  emit({
    type: "tool_execution_start",
    toolCallId: "codemode-1/1",
    toolName: "mcp__datadog__search_datadog_logs",
    args: { query: "status:error" },
    parentToolCallId: "codemode-1",
  });
  emit({
    type: "tool_execution_end",
    toolCallId: "codemode-1/1",
    toolName: "mcp__datadog__search_datadog_logs",
    result: { content: [{ type: "text", text: "one match" }] },
    isError: false,
    parentToolCallId: "codemode-1",
  });
  for (const [index, toolName, args] of [
    ["2", "bash", { command: "pwd" }],
    ["3", "read", { path: "a.ts" }],
    ["4", "read", { path: "b.ts", offset: 10 }],
    ["5", "read", { path: "c.ts", limit: 20 }],
  ] as const) {
    emit({
      type: "tool_execution_start",
      toolCallId: `codemode-1/${index}`,
      toolName,
      args,
      parentToolCallId: "codemode-1",
    });
    emit({
      type: "tool_execution_end",
      toolCallId: `codemode-1/${index}`,
      toolName,
      result: { content: [{ type: "text", text: "child result" }] },
      isError: false,
      parentToolCallId: "codemode-1",
    });
  }
  emit({
    type: "tool_execution_end",
    toolCallId: "codemode-1",
    toolName: "codemode",
    result: { content: [{ type: "text", text: "one match" }] },
    isError: false,
  });
  emit({
    type: "tool_execution_start",
    toolCallId: "direct-mcp",
    toolName: "mcp__datadog__search_datadog_logs",
    args: { query: "status:error" },
  });
  emit({
    type: "tool_execution_end",
    toolCallId: "direct-mcp",
    toolName: "mcp__datadog__search_datadog_logs",
    result: { content: [{ type: "text", text: "one match" }] },
    isError: false,
  });
  for (const [toolCallId, toolName, args] of [
    ["direct-bash", "bash", { command: "pwd" }],
    ["direct-read", "read", { path: "a.ts" }],
  ] as const) {
    emit({ type: "tool_execution_start", toolCallId, toolName, args });
    emit({
      type: "tool_execution_end",
      toolCallId,
      toolName,
      result: { content: [{ type: "text", text: "direct result" }] },
      isError: false,
    });
  }
  expect(states.map(({ callId, state }) => ({ callId, state }))).toEqual([
    { callId: "codemode-1", state: "running" },
    { callId: "codemode-1", state: "completed" },
    { callId: "direct-mcp", state: "running" },
    { callId: "direct-mcp", state: "completed" },
    { callId: "direct-bash", state: "running" },
    { callId: "direct-bash", state: "completed" },
    { callId: "direct-read", state: "running" },
    { callId: "direct-read", state: "completed" },
  ]);
});

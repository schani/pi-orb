import type { PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "vitest";
import { ComposedClaudeFixture } from "../testkit/claude-composed.ts";

const denial = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: "Delegate from the root; complete this assignment directly.",
  },
};

function invoke(
  f: ComposedClaudeFixture,
  fields: Omit<Partial<PreToolUseHookInput>, "agent_id"> & { agent_id?: string | undefined } = {},
) {
  const hook = f.query.options.hooks?.PreToolUse?.[0]?.hooks[0];
  if (hook === undefined) throw new Error("nested dispatch hook missing");
  const { agent_id: agentId = "child", ...rest } = fields;
  const root = "agent_id" in fields && fields.agent_id === undefined;
  return hook(
    {
      hook_event_name: "PreToolUse",
      session_id: f.state.id,
      transcript_path: f.nativePath,
      cwd: f.state.cwd,
      ...(root ? {} : { agent_id: agentId }),
      tool_name: "Agent",
      tool_input: { prompt: "private-prompt", run_in_background: true },
      tool_use_id: "nested-call",
      ...rest,
    },
    undefined,
    { signal: new AbortController().signal },
  );
}

it.each([
  { run_in_background: true },
  { run_in_background: false },
  {},
  { subagent_type: "custom-forced-background", run_in_background: false },
  { subagent_type: "general-purpose" },
  null,
])("denies every worker Agent call without rewriting input: %j", async (shape) => {
  const f = new ComposedClaudeFixture();
  try {
    expect((await f.attach()).isOk()).toBe(true);
    expect(
      (await f.agent.submitMessage([{ type: "text", text: "hello" }], "operation")).isOk(),
    ).toBe(true);
    const input =
      shape === null ? null : { ...shape, prompt: "private-prompt", other: "preserved" };
    const before = JSON.stringify(input);
    expect(await invoke(f, { tool_input: input })).toEqual(denial);
    expect(JSON.stringify(input)).toBe(before);
    const events = f.history.view.filter(
      (record) => record.type === "event" && record.eventType === "claude.nested_delegation_denied",
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type === "event" && events[0].custom).toMatchObject({ display: false });
    expect(events[0]?.overflow).toEqual({
      sessionId: f.state.id,
      queryId: expect.any(String),
      operationId: "operation",
      agentId: "child",
      toolUseId: "nested-call",
    });
    expect(JSON.stringify(events)).not.toContain("private-prompt");
    expect(JSON.stringify(events)).not.toContain(f.nativePath);
    expect(f.journal().ownedChildren ?? {}).toEqual({});
  } finally {
    f.dispose();
  }
});

it.each([
  { agent_id: undefined, tool_input: { run_in_background: true } },
  { agent_id: undefined, tool_input: { run_in_background: false } },
  { agent_id: undefined, agent_type: "custom-root", tool_input: { subagent_type: "custom" } },
  { agent_id: "", tool_input: { run_in_background: true } },
  { tool_name: "Bash" },
  { tool_name: "Read" },
])("leaves root delegation and ordinary worker tools unchanged: %j", async (fields) => {
  const f = new ComposedClaudeFixture();
  try {
    expect((await f.attach()).isOk()).toBe(true);
    expect(
      (await f.agent.submitMessage([{ type: "text", text: "hello" }], "operation")).isOk(),
    ).toBe(true);
    const before = JSON.stringify(fields);
    expect(await invoke(f, fields)).toEqual({});
    expect(JSON.stringify(fields)).toBe(before);
    expect(
      f.history.view.filter(
        (record) => record.type === "event" && record.eventType.startsWith("claude.nested_"),
      ),
    ).toEqual([]);
  } finally {
    f.dispose();
  }
});

it("denies worker delegation without an admitted operation", async () => {
  const f = new ComposedClaudeFixture();
  try {
    expect((await f.attach()).isOk()).toBe(true);
    expect(await invoke(f)).toEqual(denial);
    expect(
      f.history.view.filter(
        (record) =>
          record.type === "event" && record.eventType === "claude.nested_delegation_denied",
      ),
    ).toEqual([]);
  } finally {
    f.dispose();
  }
});

it("denies a stale query callback without publishing into the current operation", async () => {
  const f = new ComposedClaudeFixture();
  try {
    expect((await f.attach()).isOk()).toBe(true);
    const oldHook = f.query.options.hooks?.PreToolUse?.[0]?.hooks[0];
    expect(oldHook).toBeDefined();
    expect(
      (await f.agent.submitMessage([{ type: "text", text: "hello" }], "operation")).isOk(),
    ).toBe(true);
    expect(f.query.options.hooks?.PreToolUse?.[0]?.hooks[0]).not.toBe(oldHook);
    expect(
      await oldHook?.(
        {
          hook_event_name: "PreToolUse",
          session_id: f.state.id,
          transcript_path: f.nativePath,
          cwd: f.state.cwd,
          agent_id: "old-child",
          tool_name: "Agent",
          tool_input: {},
          tool_use_id: "old-call",
        },
        undefined,
        { signal: new AbortController().signal },
      ),
    ).toEqual(denial);
    expect(
      f.history.view.filter(
        (record) =>
          record.type === "event" && record.eventType === "claude.nested_delegation_denied",
      ),
    ).toEqual([]);
    expect(f.agent.getHealth()).toMatchObject({ status: "ready" });
  } finally {
    f.dispose();
  }
});

it("denies nested dispatch without throwing when durable publication fails", async () => {
  const f = new ComposedClaudeFixture();
  try {
    expect((await f.attach()).isOk()).toBe(true);
    expect(
      (await f.agent.submitMessage([{ type: "text", text: "hello" }], "operation")).isOk(),
    ).toBe(true);
    f.failCommit = true;
    await expect(invoke(f)).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(f.agent.getHealth()).toMatchObject({
      status: "failed",
      error: { code: "history_unavailable" },
    });
  } finally {
    f.dispose();
  }
});

import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { projectDisplayRecord } from "@pi-orb/protocol";
import { expect, it } from "vitest";
import { ComposedClaudeFixture, rootResult } from "../testkit/claude-composed.ts";
import { ClaudeHistory } from "./history.ts";

const errorResult = (fields: object): SDKMessage =>
  ({
    ...rootResult,
    uuid: "error-result",
    session_id: "native-session",
    is_error: true,
    ...fields,
  }) as unknown as SDKMessage;

async function start(f: ComposedClaudeFixture) {
  expect((await f.attach()).isOk()).toBe(true);
  const accepted = (
    await f.agent.deliverInboxMessage("first", ["first"], [{ type: "text", text: "first" }])
  )._unsafeUnwrap();
  const input = await f.query.input.next();
  if (input.done) throw new Error("Missing input");
  f.receipt(input.value);
  return { accepted, input: input.value };
}

const errors = (history: ClaudeHistory) =>
  history.view.filter(
    (record) => record.type === "event" && record.eventType === "claude.result_error",
  );

it.each([
  "error_during_execution",
  "error_max_turns",
  "error_max_budget_usd",
  "error_max_structured_output_retries",
])("retains and displays %s with SDK error strings", async (subtype) => {
  const f = new ComposedClaudeFixture();
  try {
    const { accepted } = await start(f);
    await f.query.emitUnscheduled(
      errorResult({ subtype, errors: ["first failure", "second failure"] }),
    );
    const record = errors(f.history)[0];
    expect(record).toMatchObject({
      overflow: {
        operationId: accepted.operationId,
        queryId: expect.any(String),
        sessionId: f.state.id,
        nativeSessionId: "native-session",
        resultId: "error-result",
        category: subtype,
        subtype,
        isError: true,
        errors: ["first failure", "second failure"],
        errorText: null,
        apiErrorStatus: null,
        truncated: false,
      },
    });
    expect(record && projectDisplayRecord(record)).toMatchObject({
      custom: { display: true },
      content: [{ type: "text", text: `Claude error: ${subtype}.` }],
    });
  } finally {
    f.query.exit();
    f.query.endOutput();
    await f.agent.closeExtensions();
    f.dispose();
  }
});

it("preserves every API/error result across later success, drain and history reopen", async () => {
  const f = new ComposedClaudeFixture();
  try {
    const { accepted, input } = await start(f);
    await f.agent.deliverInboxMessage("steer", ["steer"], [{ type: "text", text: "continue" }]);
    const steer = await f.query.input.next();
    if (steer.done) throw new Error("Missing steer");
    f.receipt(steer.value);
    await f.query.emitUnscheduled(
      errorResult({
        subtype: "error_during_execution",
        errors: ["worker stopped"],
        user_message_uuid: input.uuid,
        queued_turn_count: 1,
      }),
    );
    await f.query.emitUnscheduled(
      errorResult({
        uuid: "api-error",
        subtype: "success",
        result: "Overloaded; retry later",
        api_error_status: 529,
        user_message_uuid: input.uuid,
        queued_turn_count: 1,
      }),
    );
    expect(errors(f.history)).toHaveLength(2);
    expect(errors(f.history)[1]).toMatchObject({
      content: [{ type: "text", text: "Claude error: api_error (HTTP 529)." }],
      overflow: {
        category: "api_error",
        subtype: "success",
        isError: true,
        errors: [],
        errorText: "Overloaded; retry later",
        apiErrorStatus: 529,
      },
    });
    await f.query.emitUnscheduled({
      ...rootResult,
      uuid: "later-success",
      user_message_uuid: steer.value.uuid,
    } as unknown as SDKMessage);
    f.query.exit();
    f.query.endOutput();
    await f.agent.closeExtensions();
    const terminal = f.history.view.find(
      (record) => record.type === "event" && record.eventType === "claude.operation_finished",
    );
    expect(terminal).toMatchObject({
      overflow: { operationId: accepted.operationId, outcome: "failed" },
    });
    expect(f.frames).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({ type: "operation_finished", outcome: "failed" }),
      }),
    );
    const reopened = new ClaudeHistory(
      join(f.dir, "claude"),
      f.state.id,
      f.state.timestamp,
      f.files,
    );
    expect(errors(reopened)).toEqual(errors(f.history));
    expect(errors(reopened)).toHaveLength(2);
  } finally {
    f.query.exit();
    f.query.endOutput();
    await f.agent.closeExtensions();
    f.dispose();
  }
});

it("does not record ordinary success output as an error", async () => {
  const f = new ComposedClaudeFixture();
  try {
    await start(f);
    await f.query.emitUnscheduled(rootResult);
    expect(errors(f.history)).toEqual([]);
  } finally {
    f.query.exit();
    f.query.endOutput();
    await f.agent.closeExtensions();
    f.dispose();
  }
});

it("fails visibly if error diagnostics cannot be committed", async () => {
  const f = new ComposedClaudeFixture();
  try {
    await start(f);
    f.failCommit = true;
    await f.query.emitUnscheduled(errorResult({ result: "API failed", api_error_status: 500 }));
    expect(f.agent.getHealth()).toMatchObject({
      status: "failed",
      error: { code: "history_unavailable" },
    });
    expect(f.frames).not.toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({ type: "operation_finished", outcome: "completed" }),
      }),
    );
  } finally {
    f.failCommit = false;
    f.query.exit();
    f.query.endOutput();
    await f.agent.closeExtensions();
    f.dispose();
  }
});

it("records trailing errors during Abort without changing the aborted outcome", async () => {
  const f = new ComposedClaudeFixture();
  try {
    await start(f);
    const abort = f.agent.abortOperation();
    await f.query.emitUnscheduled(errorResult({ result: "interrupted", api_error_status: null }));
    expect(errors(f.history)).toHaveLength(1);
    expect(errors(f.history)[0]).toMatchObject({
      custom: { display: true },
      overflow: { category: "api_error", errorText: "interrupted", apiErrorStatus: null },
    });
    f.query.exit();
    f.query.endOutput();
    expect((await abort).isOk()).toBe(true);
    expect(
      f.history.view.find(
        (record) => record.type === "event" && record.eventType === "claude.operation_finished",
      ),
    ).toMatchObject({ overflow: { outcome: "aborted" } });
  } finally {
    f.query.exit();
    f.query.endOutput();
    await f.agent.closeExtensions();
    f.dispose();
  }
});

it("records an error subtype even if is_error is false without altering aggregation", async () => {
  const f = new ComposedClaudeFixture();
  try {
    await start(f);
    await f.query.emitUnscheduled(
      errorResult({
        subtype: "error_max_turns",
        is_error: false,
        errors: [],
      }),
    );
    expect(errors(f.history)[0]).toMatchObject({
      overflow: { category: "error_max_turns", isError: false, errors: [] },
    });
    f.query.exit();
    f.query.endOutput();
    await f.agent.closeExtensions();
    expect(
      f.history.view.find(
        (record) => record.type === "event" && record.eventType === "claude.operation_finished",
      ),
    ).toMatchObject({ overflow: { outcome: "completed" } });
  } finally {
    f.query.exit();
    f.query.endOutput();
    await f.agent.closeExtensions();
    f.dispose();
  }
});

const assistantError = (parent_tool_use_id: string | null = null): SDKMessage =>
  ({
    type: "assistant",
    uuid: "assistant-error",
    session_id: "native-session",
    parent_tool_use_id,
    error: "rate_limit",
    message: {
      content: [
        { type: "text", text: "Rate limited; Bearer private-token" },
        { type: "thinking", thinking: "private thinking", signature: "private signature" },
        { type: "tool_use", id: "private-tool", name: "tool", input: { value: "private input" } },
      ],
    },
  }) as unknown as SDKMessage;

it("journals the actual root assistant error category/text separately from result errors", async () => {
  const f = new ComposedClaudeFixture();
  try {
    await start(f);
    await f.query.emitUnscheduled(assistantError());
    const record = f.history.view.find(
      (record) => record.type === "event" && record.eventType === "claude.assistant_error",
    );
    expect(record).toMatchObject({
      custom: { display: true },
      content: [{ type: "text", text: "Claude error: rate_limit." }],
      overflow: {
        category: "rate_limit",
        resultId: null,
        messageId: "assistant-error",
        errorText: "Rate limited; [redacted]",
        apiErrorStatus: null,
      },
    });
    const reopened = new ClaudeHistory(
      join(f.dir, "claude"),
      f.state.id,
      f.state.timestamp,
      f.files,
    );
    expect(reopened.view.find((entry) => entry.id === record?.id)).toEqual(record);
    expect(record && projectDisplayRecord(record)).toMatchObject({
      content: [{ type: "text", text: "Claude error: rate_limit." }],
      custom: { display: true },
    });
    for (const secret of [
      "private-token",
      "private thinking",
      "private signature",
      "private-tool",
      "private input",
    ])
      expect(JSON.stringify(record)).not.toContain(secret);
    await f.query.emitUnscheduled(errorResult({ result: "API failure", api_error_status: 429 }));
    expect(errors(f.history)[0]).toMatchObject({
      overflow: { category: "api_error", apiErrorStatus: 429 },
    });
    expect(
      f.history.view.filter(
        (record) => record.type === "event" && record.eventType === "claude.assistant_error",
      ),
    ).toHaveLength(1);
  } finally {
    f.query.exit();
    f.query.endOutput();
    await f.agent.closeExtensions();
    f.dispose();
  }
});

it("persists a trailing root assistant error after Abort shutdown begins and fails closed", async () => {
  const f = new ComposedClaudeFixture();
  try {
    const { accepted } = await start(f);
    const query = f.query;
    const requestShutdown = query.requestShutdown.bind(query);
    const shutdownStarted = new Promise<void>((resolve) => {
      query.requestShutdown = () => {
        const result = requestShutdown();
        resolve();
        return result;
      };
    });
    const abort = f.agent.abortOperation();
    await shutdownStarted;
    expect(query.closeRequested).toBe(true);
    await query.emitUnscheduled(assistantError());
    const record = f.history.view.find(
      (record) => record.type === "event" && record.eventType === "claude.assistant_error",
    );
    expect(record).toMatchObject({
      custom: { display: true },
      content: [{ type: "text", text: "Claude error: rate_limit." }],
      overflow: {
        operationId: accepted.operationId,
        queryId: expect.any(String),
        category: "rate_limit",
        messageId: "assistant-error",
        errorText: "Rate limited; [redacted]",
      },
    });
    query.exit();
    query.endOutput();
    expect((await abort).isErr()).toBe(true);
    expect(f.agent.getHealth()).toMatchObject({
      status: "failed",
      error: { code: "claude_rotation_uncertain" },
    });
    expect(f.agent.gateView()).toMatchObject({ acceptingWork: false, activity: "busy" });
    expect(
      f.history.view.find(
        (record) => record.type === "event" && record.eventType === "claude.rotation_failed",
      ),
    ).toMatchObject({
      custom: { display: true },
      overflow: {
        reason: "root_work",
        rootWork: {
          operationId: accepted.operationId,
          messageType: "assistant",
          messageId: "assistant-error",
          signal: "root_assistant",
        },
      },
    });
    expect(
      f.history.view.some(
        (record) => record.type === "event" && record.eventType === "claude.operation_finished",
      ),
    ).toBe(false);
    expect(f.frames).not.toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({ type: "operation_finished" }),
      }),
    );
    const reopened = new ClaudeHistory(
      join(f.dir, "claude"),
      f.state.id,
      f.state.timestamp,
      f.files,
    );
    expect(reopened.view.find((entry) => entry.id === record?.id)).toEqual(record);
  } finally {
    f.query.exit();
    f.query.endOutput();
    await f.agent.closeExtensions();
    f.dispose();
  }
});

it("excludes child assistant errors from root diagnostics", async () => {
  const f = new ComposedClaudeFixture();
  try {
    await start(f);
    await f.query.emitUnscheduled(assistantError("parent-tool"));
    expect(
      f.history.view.filter(
        (record) => record.type === "event" && record.eventType === "claude.assistant_error",
      ),
    ).toEqual([]);
  } finally {
    f.query.exit();
    f.query.endOutput();
    await f.agent.closeExtensions();
    f.dispose();
  }
});

it("does not carry failure or an assistant category into the next operation", async () => {
  const f = new ComposedClaudeFixture();
  try {
    await start(f);
    await f.query.emitUnscheduled(assistantError());
    await f.query.emitUnscheduled(errorResult({ result: "Rate limited", api_error_status: 429 }));
    f.query.exit();
    f.query.endOutput();
    await f.agent.closeExtensions();
    const accepted = (
      await f.agent.deliverInboxMessage("next", ["next"], [{ type: "text", text: "next" }])
    )._unsafeUnwrap();
    const input = await f.query.input.next();
    if (input.done) throw new Error("Missing next input");
    f.receipt(input.value);
    await f.query.emitUnscheduled(rootResult);
    f.query.exit();
    f.query.endOutput();
    await f.agent.closeExtensions();
    expect(
      f.history.view.find(
        (record) =>
          record.type === "event" &&
          record.eventType === "claude.operation_finished" &&
          record.overflow.operationId === accepted.operationId,
      ),
    ).toMatchObject({ overflow: { outcome: "completed" } });
    expect(errors(f.history)).toHaveLength(1);
  } finally {
    f.query.exit();
    f.query.endOutput();
    await f.agent.closeExtensions();
    f.dispose();
  }
});

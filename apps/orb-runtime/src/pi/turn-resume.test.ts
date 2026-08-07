import { describe, expect, it } from "vitest";
import {
  detectInterruptedTurn,
  startInterruptedTurnResume,
  TURN_RESUME_CUSTOM_TYPE,
  TURN_RESUME_DECLINED_CUSTOM_TYPE,
  type TurnResumeMarker,
} from "./turn-resume.ts";

/**
 * Interrupted-turn detection is a pure function of the session tail
 * (docs/lifecycle.md). Entries here mirror the shapes the pinned SDK writes
 * to the JSONL session; turn-resume.contract.test.ts pins them against the
 * real SessionManager.
 */

let nextId = 0;
const id = (): string => `e${++nextId}`;

const entry = (type: string, extra: Record<string, unknown>): Record<string, unknown> => ({
  type,
  id: id(),
  parentId: null,
  timestamp: "2026-08-07T00:00:00.000Z",
  ...extra,
});

const user = (text = "do the thing") =>
  entry("message", { message: { role: "user", content: text, timestamp: 1 } });

const assistantText = (text = "done") =>
  entry("message", {
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
      timestamp: 2,
    },
  });

const assistantToolCalls = (...callIds: string[]) =>
  entry("message", {
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "let me look" },
        ...callIds.map((callId) => ({
          type: "toolCall",
          id: callId,
          name: "bash",
          arguments: { command: "ls" },
        })),
      ],
      stopReason: "toolUse",
      timestamp: 2,
    },
  });

const assistantAborted = (callId: string) =>
  entry("message", {
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: callId, name: "bash", arguments: {} }],
      stopReason: "aborted",
      timestamp: 2,
    },
  });

const toolResult = (callId: string) =>
  entry("message", {
    message: {
      role: "toolResult",
      toolCallId: callId,
      toolName: "bash",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: 3,
    },
  });

const bashExecution = () =>
  entry("message", {
    message: {
      role: "bashExecution",
      command: "npm test",
      output: "passing",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 4,
    },
  });

const resumeMarker = () =>
  entry("custom_message", {
    customType: TURN_RESUME_CUSTOM_TYPE,
    content: "interrupted",
    display: true,
    details: { shape: "dangling_tool_calls" },
  });

const declineMarker = () =>
  entry("custom_message", {
    customType: TURN_RESUME_DECLINED_CUSTOM_TYPE,
    content: "interrupted again",
    display: true,
    details: {},
  });

/** The record ID detection reports as the interrupted head. */
const idOf = (record: Record<string, unknown>): string => {
  const value = record["id"];
  if (typeof value !== "string") throw new Error("entry without an id");
  return value;
};

const otherCustomMessage = () =>
  entry("custom_message", { customType: "some.other", content: "hi", display: false });

const modelChange = () => entry("model_change", { provider: "openai-codex", modelId: "gpt-5.6" });
const thinkingLevelChange = () => entry("thinking_level_change", { thinkingLevel: "high" });

describe("detectInterruptedTurn", () => {
  it("reports an empty session when nothing conversational was persisted", () => {
    expect(detectInterruptedTurn([])).toEqual({ resume: false, reason: "empty_session" });
    // What createAgentSession writes for a brand-new session: metadata only.
    expect(detectInterruptedTurn([modelChange(), thinkingLevelChange()])).toEqual({
      resume: false,
      reason: "empty_session",
    });
  });

  it("resumes a trailing tool result under an assistant that stopped on toolUse", () => {
    const head = toolResult("call-1");
    const entries = [user(), assistantToolCalls("call-1"), head];
    expect(detectInterruptedTurn(entries)).toEqual({
      resume: true,
      shape: "trailing_tool_result",
      headRecordId: idOf(head),
    });
  });

  it("resumes when every tool result of a multi-call assistant message landed", () => {
    const head = toolResult("call-2");
    const entries = [user(), assistantToolCalls("call-1", "call-2"), toolResult("call-1"), head];
    expect(detectInterruptedTurn(entries)).toEqual({
      resume: true,
      shape: "trailing_tool_result",
      headRecordId: idOf(head),
    });
  });

  it("resumes an assistant message left holding its tool calls", () => {
    const head = assistantToolCalls("call-9");
    const entries = [user(), assistantText(), user(), head];
    expect(detectInterruptedTurn(entries)).toEqual({
      resume: true,
      shape: "dangling_tool_calls",
      headRecordId: idOf(head),
    });
  });

  it("resumes a user message that never got an assistant reply", () => {
    // A hard power-off can lose the assistant's first bytes entirely.
    const head = user("second");
    const entries = [user("first"), assistantText(), head];
    expect(detectInterruptedTurn(entries)).toEqual({
      resume: true,
      shape: "unanswered_user_message",
      headRecordId: idOf(head),
    });
  });

  it("ignores metadata entries the SDK appends around the tail", () => {
    const head = assistantToolCalls("call-1");
    const entries = [
      user(),
      modelChange(),
      head,
      // createAgentSession appends this when it reopens a session without one.
      thinkingLevelChange(),
    ];
    expect(detectInterruptedTurn(entries)).toEqual({
      resume: true,
      shape: "dangling_tool_calls",
      headRecordId: idOf(head),
    });
  });

  it("does not resume a completed turn", () => {
    const entries = [user(), assistantToolCalls("call-1"), toolResult("call-1"), assistantText()];
    expect(detectInterruptedTurn(entries)).toEqual({ resume: false, reason: "settled_tail" });
  });

  it("does not resume a turn the model itself ended without tool calls", () => {
    expect(detectInterruptedTurn([user(), assistantText()])).toEqual({
      resume: false,
      reason: "settled_tail",
    });
  });

  it("does not resume an aborted turn", () => {
    // An abort is durably recorded as stopReason "aborted": unlike a host
    // restart it is distinguishable on disk, and resuming it would undo the
    // one escape hatch a runaway turn has.
    expect(detectInterruptedTurn([user(), assistantAborted("call-1")])).toEqual({
      resume: false,
      reason: "settled_tail",
    });
  });

  it("does not resume a trailing tool result whose assistant did not stop on toolUse", () => {
    const entries = [user(), assistantAborted("call-1"), toolResult("call-1")];
    expect(detectInterruptedTurn(entries)).toEqual({ resume: false, reason: "settled_tail" });
  });

  it("does not resume a trailing shell execution", () => {
    // Shell operations are out of scope; only agent turns resume.
    expect(detectInterruptedTurn([user(), assistantText(), bashExecution()])).toEqual({
      resume: false,
      reason: "settled_tail",
    });
  });

  it("does not resume twice for one interruption", () => {
    // The marker was flushed, the resumed turn crashed its host again: the
    // guard is suppressing a tail that is still dangling, and nothing has told
    // the user so yet.
    const head = assistantToolCalls("c");
    const entries = [user(), assistantToolCalls("call-1"), resumeMarker(), head];
    expect(detectInterruptedTurn(entries)).toEqual({
      resume: false,
      reason: "already_resumed",
      suppressed: {
        shape: "dangling_tool_calls",
        headRecordId: idOf(head),
        announced: false,
      },
    });
  });

  it("does not resume when the crash left the marker itself as the tail", () => {
    // Nothing of the resumed turn reached the disk, so the head the guard is
    // holding back is still the pre-marker assistant message.
    const head = assistantToolCalls("call-1");
    const entries = [user(), head, resumeMarker()];
    expect(detectInterruptedTurn(entries)).toEqual({
      resume: false,
      reason: "already_resumed",
      suppressed: {
        shape: "dangling_tool_calls",
        headRecordId: idOf(head),
        announced: false,
      },
    });
  });

  it("reports no suppression when the resumed turn actually finished", () => {
    // A marker in a settled tail is an ordinary history record, not a guard
    // holding anything back — and must not produce a decline record.
    const entries = [
      user(),
      assistantToolCalls("call-1"),
      resumeMarker(),
      toolResult("call-1"),
      assistantText(),
    ];
    expect(detectInterruptedTurn(entries)).toEqual({
      resume: false,
      reason: "already_resumed",
      suppressed: null,
    });
  });

  it("reports an already-announced suppression once the decline record exists", () => {
    const head = assistantToolCalls("call-1");
    const entries = [user(), head, resumeMarker(), declineMarker()];
    expect(detectInterruptedTurn(entries)).toEqual({
      resume: false,
      reason: "already_resumed",
      suppressed: {
        shape: "dangling_tool_calls",
        headRecordId: idOf(head),
        announced: true,
      },
    });
  });

  it("is not itself settled by the decline record it appended", () => {
    // The decline record is pi-orb bookkeeping: a boot after it must reach the
    // same verdict about the same head, or the guard would flip-flop.
    const head = toolResult("call-1");
    const entries = [user(), assistantToolCalls("call-1"), head, resumeMarker(), declineMarker()];
    expect(detectInterruptedTurn(entries)).toEqual({
      resume: false,
      reason: "already_resumed",
      suppressed: {
        shape: "trailing_tool_result",
        headRecordId: idOf(head),
        announced: true,
      },
    });
  });

  it("resumes a fresh interruption even though an announced decline precedes it", () => {
    // The user answered the declined turn: the next interruption is a new one.
    const head = assistantToolCalls("call-2");
    const entries = [
      user("first"),
      assistantToolCalls("call-1"),
      resumeMarker(),
      declineMarker(),
      user("second"),
      head,
    ];
    expect(detectInterruptedTurn(entries)).toEqual({
      resume: true,
      shape: "dangling_tool_calls",
      headRecordId: idOf(head),
    });
  });

  it("resumes again for an interruption after the marked one", () => {
    // A marker before the last real user message belongs to a finished
    // episode: the next turn's interruption must still resume.
    const head = assistantToolCalls("call-2");
    const entries = [
      user("first"),
      assistantToolCalls("call-1"),
      resumeMarker(),
      assistantText(),
      user("second"),
      head,
    ];
    expect(detectInterruptedTurn(entries)).toEqual({
      resume: true,
      shape: "dangling_tool_calls",
      headRecordId: idOf(head),
    });
  });

  it("is not blocked by an unrelated extension's custom message", () => {
    const head = assistantToolCalls("call-1");
    const entries = [user(), otherCustomMessage(), head];
    expect(detectInterruptedTurn(entries)).toEqual({
      resume: true,
      shape: "dangling_tool_calls",
      headRecordId: idOf(head),
    });
  });

  it("treats a malformed entry as a settled tail rather than throwing", () => {
    expect(detectInterruptedTurn([user(), { type: "message" }])).toEqual({
      resume: false,
      reason: "settled_tail",
    });
    expect(detectInterruptedTurn([null, "nonsense"])).toEqual({
      resume: false,
      reason: "settled_tail",
    });
  });
});

interface RecordedCall {
  readonly message: TurnResumeMarker;
  readonly options:
    | { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }
    | undefined;
}

function recordingSession(behavior: () => Promise<void>) {
  const calls: RecordedCall[] = [];
  return {
    calls,
    session: {
      sendCustomMessage: (
        message: TurnResumeMarker,
        options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
      ): Promise<void> => {
        calls.push({ message, options });
        return behavior();
      },
    },
  };
}

describe("startInterruptedTurnResume", () => {
  it("issues no record and reports nothing for a settled tail", () => {
    const { calls, session } = recordingSession(() => Promise.resolve());
    const attempt = startInterruptedTurnResume([user(), assistantText()], session);

    expect(attempt.decision).toEqual({ resume: false, reason: "settled_tail" });
    expect(attempt.issued).toBeNull();
    expect(attempt.marker).toBeNull();
    // An ordinary boot is a level, not an edge: health reports nothing.
    expect(attempt.observation).toBeNull();
    expect(calls).toEqual([]);
  });

  it("reports nothing for a fresh session", () => {
    const { calls, session } = recordingSession(() => Promise.resolve());
    const attempt = startInterruptedTurnResume([], session);

    expect(attempt.observation).toBeNull();
    expect(calls).toEqual([]);
  });

  it("issues exactly one visible, turn-triggering marker for an interrupted tail", async () => {
    const { calls, session } = recordingSession(() => Promise.resolve());
    const head = assistantToolCalls("call-1");
    const attempt = startInterruptedTurnResume([user(), head], session);

    expect(attempt.decision).toEqual({
      resume: true,
      shape: "dangling_tool_calls",
      headRecordId: idOf(head),
    });
    expect(calls.length).toBe(1);
    const call = calls[0];
    if (call === undefined) throw new Error("unreachable");
    expect(call.message.customType).toBe(TURN_RESUME_CUSTOM_TYPE);
    expect(call.message.display).toBe(true);
    expect(call.message.content).toContain("interrupted");
    // The replicated record alone must be enough to audit the decision.
    expect(call.message.details).toEqual({
      shape: "dangling_tool_calls",
      headRecordId: idOf(head),
    });
    expect(call.options).toEqual({ triggerTurn: true });
    expect(attempt.observation).toEqual({
      outcome: "resumed",
      shape: "dangling_tool_calls",
      headRecordId: idOf(head),
    });

    const issued = attempt.issued;
    if (issued === null) throw new Error("expected an issued marker");
    expect((await issued).isOk()).toBe(true);
  });

  it("carries the interrupted head of a trailing tool result in the marker", () => {
    const { calls, session } = recordingSession(() => Promise.resolve());
    const head = toolResult("call-1");
    startInterruptedTurnResume([user(), assistantToolCalls("call-1"), head], session);

    expect(calls[0]?.message.details).toEqual({
      shape: "trailing_tool_result",
      headRecordId: idOf(head),
    });
  });

  it("announces a declined resume with a visible record that triggers no turn", async () => {
    const { calls, session } = recordingSession(() => Promise.resolve());
    const head = assistantToolCalls("call-1");
    const attempt = startInterruptedTurnResume([user(), head, resumeMarker()], session);

    expect(attempt.decision).toEqual({
      resume: false,
      reason: "already_resumed",
      suppressed: {
        shape: "dangling_tool_calls",
        headRecordId: idOf(head),
        announced: false,
      },
    });
    expect(calls.length).toBe(1);
    const call = calls[0];
    if (call === undefined) throw new Error("unreachable");
    expect(call.message.customType).toBe(TURN_RESUME_DECLINED_CUSTOM_TYPE);
    expect(call.message.display).toBe(true);
    expect(call.message.content).toContain("Send a message to continue");
    expect(call.message.details).toEqual({ headRecordId: idOf(head) });
    // Declining *is* the decision: the record must not start a turn.
    expect(call.options).toBeUndefined();
    expect(attempt.observation).toEqual({
      outcome: "declined_already_resumed",
      shape: "dangling_tool_calls",
      headRecordId: idOf(head),
    });

    const issued = attempt.issued;
    if (issued === null) throw new Error("expected an issued record");
    expect((await issued).isOk()).toBe(true);
  });

  it("announces a declined resume at most once per interruption", () => {
    const { calls, session } = recordingSession(() => Promise.resolve());
    const head = assistantToolCalls("call-1");
    const attempt = startInterruptedTurnResume(
      [user(), head, resumeMarker(), declineMarker()],
      session,
    );

    expect(calls).toEqual([]);
    expect(attempt.marker).toBeNull();
    // The boot still declined, and health still says so: the record
    // deduplicates across boots, the health field describes this one.
    expect(attempt.observation).toEqual({
      outcome: "declined_already_resumed",
      shape: "dangling_tool_calls",
      headRecordId: idOf(head),
    });
  });

  it("does not announce anything when the earlier resume actually finished", () => {
    const { calls, session } = recordingSession(() => Promise.resolve());
    const attempt = startInterruptedTurnResume(
      [user(), assistantToolCalls("call-1"), resumeMarker(), toolResult("call-1"), assistantText()],
      session,
    );

    expect(calls).toEqual([]);
    expect(attempt.observation).toBeNull();
  });

  it("returns synchronously while the resumed turn is still running", async () => {
    // Proof that boot cannot block on the resume: with triggerTurn the SDK
    // settles its promise only when the whole turn does.
    let settle: (() => void) | undefined;
    const { calls, session } = recordingSession(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );

    const attempt = startInterruptedTurnResume([user(), assistantToolCalls("call-1")], session);
    expect(attempt.decision.resume).toBe(true);
    expect(calls.length).toBe(1);

    let done = false;
    const issued = attempt.issued;
    if (issued === null) throw new Error("expected an issued marker");
    void Promise.resolve(issued).then(() => {
      done = true;
    });
    // Drain every pending microtask: the marker's promise is still open.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(done).toBe(false);

    settle?.();
    expect((await issued).isOk()).toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(done).toBe(true);
  });

  it("maps an SDK rejection to a typed error instead of throwing", async () => {
    const { session } = recordingSession(() => Promise.reject(new Error("no model")));
    const attempt = startInterruptedTurnResume([user(), assistantToolCalls("call-1")], session);

    const issued = attempt.issued;
    if (issued === null) throw new Error("expected an issued marker");
    const result = await issued;
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toBe("no model");
  });

  it("maps a synchronous SDK throw to a typed error instead of throwing", async () => {
    const attempt = startInterruptedTurnResume([user(), assistantToolCalls("call-1")], {
      sendCustomMessage: () => {
        throw new Error("session is closed");
      },
    });

    const issued = attempt.issued;
    if (issued === null) throw new Error("expected an issued marker");
    const result = await issued;
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toBe("session is closed");
  });
});

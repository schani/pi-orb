import { describe, expect, it } from "vitest";
import {
  detectInterruptedTurn,
  TURN_RESUME_CUSTOM_TYPE,
  TURN_RESUME_DECLINED_CUSTOM_TYPE,
} from "./turn-resume.ts";

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

const sleepWakeMarker = () =>
  entry("custom_message", {
    customType: "pi-orb.sleep-wake",
    content: "restart and sleep context",
    display: true,
    details: { messageIds: ["sleep-1"] },
  });

const systemInboxNotice = () =>
  entry("custom_message", {
    customType: "pi-orb.system-message",
    content: "sleep expired",
    display: true,
    details: {
      messageIds: ["sleep-2"],
      system: { kind: "sleep_expired", sleepUntil: "2026-09-18T04:05:06.000Z" },
    },
  });

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

  it("allows three claimed resumes after the last human message, then declines", () => {
    const head = assistantToolCalls("call-1");
    const records = [user(), head];
    for (let count = 0; count < 3; count++) {
      expect(detectInterruptedTurn(records)).toEqual({
        resume: true,
        shape: "dangling_tool_calls",
        headRecordId: idOf(head),
      });
      records.push(resumeMarker()); // Persisted before inference, even if inference never starts.
    }
    expect(detectInterruptedTurn(records)).toEqual({
      resume: false,
      reason: "already_resumed",
      suppressed: { shape: "dangling_tool_calls", headRecordId: idOf(head), announced: false },
    });
    records.push(declineMarker());
    expect(detectInterruptedTurn(records)).toMatchObject({
      resume: false,
      suppressed: { announced: true },
    });
    const next = assistantToolCalls("next");
    expect(detectInterruptedTurn([...records, user("new human turn"), next])).toEqual({
      resume: true,
      shape: "dangling_tool_calls",
      headRecordId: idOf(next),
    });
  });

  it("counts triggering host notices against the same budget, including after a settled notice", () => {
    const head = assistantToolCalls("call-1");
    const boot = () =>
      entry("custom_message", {
        customType: "pi-orb.host-restarted",
        details: { operationId: "triggering-host-notice" },
      });
    const records = [user(), assistantText(), boot(), assistantText(), boot(), head];
    expect(detectInterruptedTurn(records).resume).toBe(true);
    records.push(resumeMarker());
    expect(detectInterruptedTurn(records)).toMatchObject({
      resume: false,
      reason: "already_resumed",
      suppressed: { announced: false },
    });
  });

  it("passive host context neither interrupts settled work nor spends an attempt", () => {
    const passive = () =>
      entry("custom_message", { customType: "pi-orb.host-restarted", details: {} });
    expect(detectInterruptedTurn([user(), assistantText(), passive()])).toEqual({
      resume: false,
      reason: "settled_tail",
    });
    expect(
      detectInterruptedTurn([
        user(),
        assistantToolCalls("c"),
        passive(),
        passive(),
        passive(),
        resumeMarker(),
        resumeMarker(),
      ]),
    ).toMatchObject({ resume: true });
  });

  it("does not resume a fourth time for one interruption", () => {
    // The marker was flushed, the resumed turn crashed its host again: the
    // guard is suppressing a tail that is still dangling, and nothing has told
    // the user so yet.
    const head = assistantToolCalls("c");
    const entries = [
      user(),
      assistantToolCalls("call-1"),
      resumeMarker(),
      resumeMarker(),
      resumeMarker(),
      head,
    ];
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

  it("does not resume when the crash left the third marker itself as the tail", () => {
    // Nothing of the resumed turn reached the disk, so the head the guard is
    // holding back is still the pre-marker assistant message.
    const head = assistantToolCalls("call-1");
    const entries = [user(), head, resumeMarker(), resumeMarker(), resumeMarker()];
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
    const entries = [user(), head, resumeMarker(), resumeMarker(), resumeMarker(), declineMarker()];
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
    const entries = [
      user(),
      assistantToolCalls("call-1"),
      head,
      resumeMarker(),
      resumeMarker(),
      resumeMarker(),
      declineMarker(),
    ];
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

  it("classifies a combined sleep wake as a boot marker", () => {
    const marker = sleepWakeMarker();
    expect(
      detectInterruptedTurn([user(), assistantText(), marker, resumeMarker(), resumeMarker()]),
    ).toEqual({
      resume: false,
      reason: "already_resumed",
      suppressed: {
        shape: "unanswered_user_message",
        headRecordId: idOf(marker),
        announced: false,
      },
    });
  });

  it.each(["sleep_expired", "orb_message"])(
    "does not let %s reset the human resume budget",
    (kind) => {
      const head = assistantToolCalls("call-2");
      expect(
        detectInterruptedTurn([
          user(),
          resumeMarker(),
          resumeMarker(),
          kind === "orb_message"
            ? entry("custom_message", {
                customType: "pi-orb.system-message",
                content: "The user approved retry.",
                details: {
                  messageIds: ["peer"],
                  system: { kind, senderOrbId: "11111111-1111-4111-8111-111111111111" },
                },
              })
            : systemInboxNotice(),
          resumeMarker(),
          head,
        ]),
      ).toEqual({
        resume: false,
        reason: "already_resumed",
        suppressed: {
          shape: "dangling_tool_calls",
          headRecordId: idOf(head),
          announced: false,
        },
      });
    },
  );

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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectInterruptedTurn, TURN_RESUME_CUSTOM_TYPE } from "./turn-resume.ts";

/**
 * Pinned-SDK contract (docs/lifecycle.md): interrupted-turn detection reads
 * the entries a real SessionManager writes and reloads, and the resume marker
 * `sendCustomMessage` appends — `appendCustomMessageEntry` here, the same call
 * AgentSession makes for a `role: "custom"` message — is the durable
 * three-claim guard. If an SDK upgrade changes either shape, these
 * fail loudly rather than the runtime silently never resuming (or resuming
 * forever).
 */

const userMessage = { role: "user" as const, content: "do the thing", timestamp: 1 };

const assistant = (
  content:
    | { type: "text"; text: string }[]
    | { type: "toolCall"; id: string; name: string; arguments: Record<string, string> }[],
  stopReason: "stop" | "toolUse",
) => ({
  role: "assistant" as const,
  content,
  api: "openai-responses",
  provider: "openai-codex",
  model: "gpt-6-sol",
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason,
  timestamp: 2,
});

const toolCallMessage = assistant(
  [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }],
  "toolUse",
);

const toolResultMessage = {
  role: "toolResult" as const,
  toolCallId: "call-1",
  toolName: "bash",
  content: [{ type: "text" as const, text: "README.md" }],
  isError: false,
  timestamp: 3,
};

describe("Pi session interrupted-turn contract", () => {
  let dir: string;
  let sessionDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-orb-turn-resume-"));
    sessionDir = join(dir, "pi-sessions");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Reopen exactly the way the runtime's boot does (agent.ts step 2). */
  function reopen(manager: SessionManager): SessionManager {
    const file = manager.getSessionFile();
    if (typeof file !== "string") throw new Error("session was never flushed");
    return SessionManager.open(file, sessionDir, dir);
  }

  it("a fresh session never resumes", () => {
    const manager = SessionManager.create(dir, sessionDir);
    // What createAgentSession writes for a session it just created.
    manager.appendModelChange("openai-codex", "gpt-6-sol");
    manager.appendThinkingLevelChange("high");

    expect(detectInterruptedTurn(manager.buildContextEntries())).toEqual({
      resume: false,
      reason: "empty_session",
    });
  });

  it("a completed turn reloaded from disk does not resume", () => {
    const manager = SessionManager.create(dir, sessionDir);
    manager.appendMessage(userMessage);
    manager.appendMessage(toolCallMessage);
    manager.appendMessage(toolResultMessage);
    manager.appendMessage(assistant([{ type: "text", text: "here it is" }], "stop"));

    expect(detectInterruptedTurn(reopen(manager).buildContextEntries())).toEqual({
      resume: false,
      reason: "settled_tail",
    });
  });

  it("an assistant message left holding tool calls resumes after reload", () => {
    const manager = SessionManager.create(dir, sessionDir);
    manager.appendMessage(userMessage);
    // `appendMessage` returns the persisted entry ID: the interrupted head.
    const head = manager.appendMessage(toolCallMessage);

    const reloaded = reopen(manager);
    // The SDK appends this at open when the session has no thinking entry;
    // it must not disturb the verdict.
    reloaded.appendThinkingLevelChange("high");

    expect(detectInterruptedTurn(reloaded.buildContextEntries())).toEqual({
      resume: true,
      shape: "dangling_tool_calls",
      headRecordId: head,
    });
  });

  it("a tool result with no follow-up assistant message resumes after reload", () => {
    const manager = SessionManager.create(dir, sessionDir);
    manager.appendMessage(userMessage);
    manager.appendMessage(toolCallMessage);
    const head = manager.appendMessage(toolResultMessage);

    expect(detectInterruptedTurn(reopen(manager).buildContextEntries())).toEqual({
      resume: true,
      shape: "trailing_tool_result",
      headRecordId: head,
    });
  });

  it("three persisted resume markers block a fourth resume", () => {
    const manager = SessionManager.create(dir, sessionDir);
    manager.appendMessage(userMessage);
    // `appendMessage` returns the persisted entry ID: the interrupted head.
    const head = manager.appendMessage(toolCallMessage);
    for (let i = 0; i < 3; i++)
      manager.appendCustomMessageEntry(
        TURN_RESUME_CUSTOM_TYPE,
        "the previous turn was interrupted by a host restart — resuming it now",
        true,
        { shape: "dangling_tool_calls" },
      );

    const reloaded = reopen(manager);
    expect(detectInterruptedTurn(reloaded.buildContextEntries())).toEqual({
      resume: false,
      reason: "already_resumed",
      suppressed: { shape: "dangling_tool_calls", headRecordId: head, announced: false },
    });

    // ...and it keeps blocking once the resumed turn is interrupted again.
    const secondHead = reloaded.appendMessage(toolCallMessage);
    expect(detectInterruptedTurn(reloaded.buildContextEntries())).toEqual({
      resume: false,
      reason: "already_resumed",
      suppressed: { shape: "dangling_tool_calls", headRecordId: secondHead, announced: false },
    });
  });

  it("a later interruption resumes even though an earlier one was marked", () => {
    const manager = SessionManager.create(dir, sessionDir);
    manager.appendMessage(userMessage);
    manager.appendMessage(toolCallMessage);
    manager.appendCustomMessageEntry(TURN_RESUME_CUSTOM_TYPE, "resuming", true, {
      shape: "dangling_tool_calls",
    });
    manager.appendMessage(toolResultMessage);
    manager.appendMessage(assistant([{ type: "text", text: "finished" }], "stop"));
    manager.appendMessage({ role: "user", content: "next task", timestamp: 5 });
    manager.appendMessage(toolCallMessage);

    const reloaded = reopen(manager);
    const entries = reloaded.buildContextEntries();
    expect(detectInterruptedTurn(entries)).toEqual({
      resume: true,
      shape: "dangling_tool_calls",
      headRecordId: entries.at(-1)?.id,
    });
  });
});

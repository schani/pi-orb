import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionFlushed } from "./session-flush.ts";

/**
 * Pinned-SDK contract (DESIGN.md §8.5): the SessionManager does NOT write
 * its session file until the first assistant message exists — everything
 * before that lives only in memory. The runtime's snapshot gate
 * (`sessionFlushed`) relies on exactly this behavior; if an SDK upgrade
 * changes the flush rule, these tests must fail loudly so the gate is
 * re-evaluated.
 */

const userMessage = { role: "user" as const, content: "hello", timestamp: 1 };
const assistantMessage = {
  role: "assistant" as const,
  content: [{ type: "text" as const, text: "hi!" }],
  api: "openai-responses",
  provider: "openai-codex",
  model: "gpt-5.6-sol",
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop" as const,
  timestamp: 2,
};

describe("Pi session lazy-flush contract", () => {
  let dir: string;
  let sessionDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-orb-session-flush-"));
    sessionDir = join(dir, "pi-sessions");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function listSessionFiles(): string[] {
    if (!existsSync(sessionDir)) return [];
    return readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl"));
  }

  it("persists nothing before the first assistant message", () => {
    const manager = SessionManager.create(dir, sessionDir);
    manager.appendModelChange("openai-codex", "gpt-5.6-sol");
    manager.appendThinkingLevelChange("high");
    manager.appendMessage(userMessage);

    // Entries exist in memory and would be served by an ungated snapshot...
    expect(manager.getEntries().length).toBe(3);
    // ...but nothing exists on disk: a restart would lose all of them.
    expect(listSessionFiles()).toEqual([]);
    expect(sessionFlushed(manager)).toBe(false);
  });

  it("the first assistant message flushes the entire session to disk", () => {
    const manager = SessionManager.create(dir, sessionDir);
    manager.appendModelChange("openai-codex", "gpt-5.6-sol");
    manager.appendMessage(userMessage);
    manager.appendMessage(assistantMessage);

    expect(sessionFlushed(manager)).toBe(true);
    const files = listSessionFiles();
    expect(files.length).toBe(1);
    const fileName = files[0];
    if (fileName === undefined) throw new Error("unreachable");
    const lines = readFileSync(join(sessionDir, fileName), "utf8").trim().split("\n");
    // Header plus every in-memory entry, in order.
    expect(lines.length).toBe(1 + manager.getEntries().length);
    const fileIds = lines
      .map((line) => JSON.parse(line) as { id?: string; type: string })
      .filter((entry) => entry.type !== "session")
      .map((entry) => entry.id)
      .filter((id): id is string => id !== undefined);
    expect(fileIds).toEqual(manager.getEntries().map((entry) => entry.id));
  });

  it("appends after the flush persist immediately", () => {
    const manager = SessionManager.create(dir, sessionDir);
    manager.appendMessage(userMessage);
    manager.appendMessage(assistantMessage);
    const file = manager.getSessionFile();
    if (typeof file !== "string") throw new Error("no session file after flush");
    const linesBefore = readFileSync(file, "utf8").trim().split("\n").length;

    manager.appendMessage({ role: "user", content: "and another thing", timestamp: 3 });
    const linesAfter = readFileSync(file, "utf8").trim().split("\n").length;
    expect(linesAfter).toBe(linesBefore + 1);
    expect(sessionFlushed(manager)).toBe(true);
  });

  it("a reopened session preserves entry ids (cursor continuity)", () => {
    const manager = SessionManager.create(dir, sessionDir);
    manager.appendModelChange("openai-codex", "gpt-5.6-sol");
    manager.appendMessage(userMessage);
    manager.appendMessage(assistantMessage);
    const idsBefore = manager.getEntries().map((entry) => entry.id);
    const file = manager.getSessionFile();
    if (typeof file !== "string") throw new Error("no session file after flush");

    const reopened = SessionManager.open(file, sessionDir, dir);
    expect(reopened.getEntries().map((entry) => entry.id)).toEqual(idsBefore);
    expect(sessionFlushed(reopened)).toBe(true);
  });
});

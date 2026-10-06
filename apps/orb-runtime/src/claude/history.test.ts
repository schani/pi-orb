import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeHistory, nativeHistoryFiles } from "./history.ts";

const dirs: string[] = [];
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-history-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe("native Claude root authority", () => {
  it("preserves full compaction log, images, tools, native identity, and deterministic UUID-less entries", () => {
    const dir = fixture();
    const file = join(dir, "root.jsonl");
    const lines = [
      {
        type: "user",
        uuid: "u",
        parentUuid: null,
        timestamp: "2026-10-04T00:00:00Z",
        message: {
          role: "user",
          content: [
            { type: "text", text: "before" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "YWJj" } },
          ],
        },
      },
      {
        type: "assistant",
        uuid: "a",
        parentUuid: "u",
        timestamp: "2026-10-04T00:01:00Z",
        message: {
          role: "assistant",
          model: "claude-test",
          content: [
            { type: "thinking", thinking: "reason" },
            { type: "tool_use", id: "call", name: "Bash", input: { command: "pwd" } },
          ],
        },
      },
      {
        type: "user",
        uuid: "t",
        parentUuid: "a",
        timestamp: "2026-10-04T00:02:00Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call", content: "output" }],
        },
      },
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "c",
        parentUuid: "t",
        timestamp: "2026-10-04T00:03:00Z",
        content: "summary",
        compactMetadata: {},
      },
      { type: "file-history-snapshot", snapshot: { private: "configuration" } },
    ];
    writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    const history = new ClaudeHistory(dir, "session", "2026-10-04T00:00:00Z");
    history.correlate("u", { messageIds: ["inbox"], operationId: "op" })._unsafeUnwrap();
    const records = history.scan(file)._unsafeUnwrap();
    expect(records).toHaveLength(5);
    expect(records[0]).toMatchObject({
      id: "u",
      parentId: null,
      inboxMessageIds: ["inbox"],
      content: [
        { type: "text", text: "before" },
        { type: "image", mediaType: "image/png", data: "YWJj" },
      ],
    });
    expect(records[1]).toMatchObject({
      model: { id: "claude-test", provider: "anthropic" },
      content: [
        { type: "reasoning", text: "reason" },
        { type: "tool_call", callId: "call", name: "Bash", arguments: { command: "pwd" } },
      ],
    });
    expect(records[2]).toMatchObject({
      role: "tool",
      content: [
        { type: "tool_result", callId: "call", content: [{ type: "text", text: "output" }] },
      ],
    });
    expect(records[3]).toMatchObject({
      type: "compaction",
      summary: [{ type: "text", text: "summary" }],
    });
    expect(JSON.stringify(records[4])).not.toContain("configuration");
    expect(
      new ClaudeHistory(dir, "session", "2026-10-04T00:00:00Z").scan(file)._unsafeUnwrap(),
    ).toEqual(records);
  });
  it("fails closed on malformed native entries and corrupt private indexes", () => {
    const dir = fixture();
    const file = join(dir, "root.jsonl");
    writeFileSync(file, "null\n");
    expect(new ClaudeHistory(dir, "s", "2026-10-04T00:00:00Z").scan(file).isErr()).toBe(true);
    writeFileSync(join(dir, "index.json"), '{"records":null,"fingerprints":[]}');
    expect(new ClaudeHistory(dir, "s", "2026-10-04T00:00:00Z").scan(file).isErr()).toBe(true);
  });
  it("does not publish or advance on failed index commit", () => {
    const dir = fixture();
    const file = join(dir, "root.jsonl");
    writeFileSync(
      file,
      JSON.stringify({ type: "user", uuid: "u", message: { content: "hi" } }) + "\n",
    );
    const history = new ClaudeHistory(dir, "s", "2026-10-04T00:00:00Z", {
      ...nativeHistoryFiles,
      commit: () => {
        throw new Error("injected commit failure");
      },
    });
    expect(history.scan(file).isErr()).toBe(true);
    expect(history.view).toEqual([]);
  });
  it("waits for newline and rejects mutation rather than changing committed records", () => {
    const dir = fixture();
    const file = join(dir, "root.jsonl");
    const entry = { type: "user", uuid: "u", message: { role: "user", content: "hi" } };
    writeFileSync(file, JSON.stringify(entry));
    const history = new ClaudeHistory(dir, "s", "2026-10-04T00:00:00Z");
    expect(history.scan(file)._unsafeUnwrap()).toEqual([]);
    appendFileSync(file, "\n");
    expect(history.scan(file)._unsafeUnwrap()).toHaveLength(1);
    writeFileSync(
      file,
      `${JSON.stringify({ ...entry, message: { role: "user", content: "changed" } })}\n`,
    );
    expect(history.scan(file).isErr()).toBe(true);
  });
  it("commits platform events without modifying native resume state", () => {
    const dir = fixture();
    const file = join(dir, "root.jsonl");
    const history = new ClaudeHistory(dir, "s", "2026-10-04T00:00:00Z");
    const record = {
      id: "alert",
      parentId: null,
      timestamp: "2026-10-04T00:00:00Z",
      type: "event" as const,
      eventType: "claude.platform",
      content: [{ type: "text" as const, text: "hello" }],
      overflow: {},
    };
    history.appendPlatform(record)._unsafeUnwrap();
    expect(new ClaudeHistory(dir, "s", "2026-10-04T00:00:00Z").scan(file)._unsafeUnwrap()).toEqual([
      record,
    ]);
  });
  it("does not leak native child/config events into product overflow", () => {
    const dir = fixture();
    const file = join(dir, "root.jsonl");
    writeFileSync(
      file,
      JSON.stringify({ type: "progress", uuid: "p", data: { childTranscript: "private" } }) + "\n",
    );
    expect(
      JSON.stringify(
        new ClaudeHistory(dir, "s", "2026-10-04T00:00:00Z").scan(file)._unsafeUnwrap(),
      ),
    ).not.toContain("private");
  });
});

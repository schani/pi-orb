import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
        content: "Conversation compacted",
        compactMetadata: { trigger: "auto" },
      },
      {
        type: "user",
        uuid: "summary",
        parentUuid: "c",
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
        message: { role: "user", content: "native summary" },
      },
      { type: "file-history-snapshot", snapshot: { private: "configuration" } },
    ];
    writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    const history = new ClaudeHistory(dir, "session", "2026-10-04T00:00:00Z");
    history.correlate("u", { messageIds: ["inbox"], operationId: "op" })._unsafeUnwrap();
    const records = history.scan(file)._unsafeUnwrap();
    expect(records).toHaveLength(6);
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
    expect(records[3]).toMatchObject({ type: "event", eventType: "claude.compact_boundary" });
    expect(records[4]).toMatchObject({
      id: "summary",
      parentId: "c",
      type: "compaction",
      summary: [{ type: "text", text: "native summary" }],
    });
    expect(JSON.stringify(records[5])).not.toContain("configuration");
    expect(
      new ClaudeHistory(dir, "session", "2026-10-04T00:00:00Z").scan(file)._unsafeUnwrap(),
    ).toEqual(records);
  });
  it("commits native boundaries and partial summaries separately without a human command echo", () => {
    const dir = fixture();
    const file = join(dir, "root.jsonl");
    const history = new ClaudeHistory(dir, "s", "2026-10-04T00:00:00Z");
    history
      .correlate("command", { messageIds: [], operationId: "op", compaction: true })
      ._unsafeUnwrap();
    const command = {
      type: "user",
      uuid: "command",
      message: { content: "/compact private instructions" },
    };
    const boundary = {
      type: "system",
      subtype: "compact_boundary",
      uuid: "boundary",
      parentUuid: "command",
      content: "Conversation compacted",
      compactMetadata: { trigger: "manual" },
    };
    const summary = {
      type: "user",
      uuid: "summary",
      parentUuid: "boundary",
      isCompactSummary: true,
      message: { content: "canonical summary" },
    };
    writeFileSync(
      file,
      `${JSON.stringify(command)}\n${JSON.stringify(boundary)}\n${JSON.stringify(summary)}`,
    );
    const before = history.scan(file)._unsafeUnwrap();
    expect(before.every((record) => record.type === "event")).toBe(true);
    expect(JSON.stringify(before)).not.toContain("private instructions");
    appendFileSync(file, "\n");
    const after = history.scan(file)._unsafeUnwrap();
    expect(after.at(-1)).toMatchObject({
      id: "summary",
      parentId: "boundary",
      type: "compaction",
      summary: [{ type: "text", text: "canonical summary" }],
    });
    expect(new ClaudeHistory(dir, "s", "2026-10-04T00:00:00Z").scan(file)._unsafeUnwrap()).toEqual(
      after,
    );
  });
  it("hides correlated native compact echoes, not ordinary human slash text", () => {
    const dir = fixture();
    const file = join(dir, "root.jsonl");
    const echo = {
      type: "user",
      uuid: "native-echo",
      promptId: "independent-prompt",
      entrypoint: "sdk-ts",
      userType: "external",
      message: {
        role: "user",
        content:
          "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>private instructions</command-args>",
      },
    };
    const human = {
      type: "user",
      uuid: "human",
      message: { content: "/compact ordinary human text" },
    };
    const humanXml = { ...echo, uuid: "human-xml" };
    writeFileSync(
      file,
      `${JSON.stringify(echo)}\n${JSON.stringify(human)}\n${JSON.stringify(humanXml)}\n`,
    );
    const history = new ClaudeHistory(dir, "s", "2026-10-06T00:00:00Z");
    history
      .correlate("native-echo", { messageIds: [], operationId: "manual", compaction: true })
      ._unsafeUnwrap();
    const records = history.scan(file)._unsafeUnwrap();
    expect(records[0]).toMatchObject({
      id: "native-echo",
      type: "event",
      eventType: "claude.compact_command",
    });
    expect(JSON.stringify(records[0])).not.toContain("private instructions");
    expect(records[1]).toMatchObject({
      type: "message",
      role: "user",
      content: [{ type: "text", text: "/compact ordinary human text" }],
    });
    expect(records[2]).toMatchObject({
      type: "message",
      role: "user",
      content: [{ type: "text", text: echo.message.content }],
    });
  });
  it("keeps native compact caveats and linked stdout private across incremental scans and reopen", () => {
    const dir = fixture();
    const file = join(dir, "root.jsonl");
    const history = new ClaudeHistory(dir, "s", "2026-10-06T00:00:00Z");
    const command = {
      type: "user",
      uuid: "command",
      parentUuid: null,
      message: { role: "user", content: "<command-name>/compact</command-name>" },
    };
    const boundary = {
      type: "system",
      subtype: "compact_boundary",
      uuid: "boundary",
      parentUuid: "command",
    };
    const summary = {
      type: "user",
      uuid: "summary",
      parentUuid: "boundary",
      isCompactSummary: true,
      message: { role: "user", content: "canonical summary" },
    };
    const caveat = {
      type: "user",
      uuid: "caveat",
      parentUuid: "summary",
      isMeta: true,
      message: {
        role: "user",
        content:
          "<local-command-caveat>The command below was run directly in Claude Code.</local-command-caveat>",
      },
    };
    const stdout = {
      type: "user",
      uuid: "stdout",
      parentUuid: "command",
      message: { role: "user", content: "<local-command-stdout>Compacted </local-command-stdout>" },
    };
    history
      .correlate("command", { messageIds: [], operationId: "compact", compaction: true })
      ._unsafeUnwrap();
    writeFileSync(
      file,
      [command, boundary, summary].map((row) => JSON.stringify(row)).join("\n") + "\n",
    );
    history.scan(file)._unsafeUnwrap();
    appendFileSync(file, JSON.stringify(caveat) + "\n");
    history.scan(file)._unsafeUnwrap();
    appendFileSync(file, JSON.stringify(stdout) + "\n");
    const records = new ClaudeHistory(dir, "s", "2026-10-06T00:00:00Z").scan(file)._unsafeUnwrap();
    expect(records.filter((record) => record.type === "message")).toEqual([]);
    expect(records.filter((record) => record.type === "compaction")).toHaveLength(1);
    expect(records.find((record) => record.id === "stdout")).toMatchObject({
      type: "event",
      parentId: "command",
      eventType: "claude.compact_command",
    });
    expect(JSON.stringify(records)).not.toContain("local-command-");
    expect(new ClaudeHistory(dir, "s", "2026-10-06T00:00:00Z").scan(file)._unsafeUnwrap()).toEqual(
      records,
    );
  });
  it("preserves literal command wrappers in real inbox and unrelated human records", () => {
    const dir = fixture();
    const file = join(dir, "root.jsonl");
    const history = new ClaudeHistory(dir, "s", "2026-10-06T00:00:00Z");
    history
      .correlate("command", { messageIds: [], operationId: "compact", compaction: true })
      ._unsafeUnwrap();
    history
      .correlate("inbox", { messageIds: ["real-inbox"], operationId: "human" })
      ._unsafeUnwrap();
    const rows = [
      { type: "user", uuid: "command", message: { content: "/compact" } },
      ...["inbox", "foreign", "ordinary"].map((uuid) => ({
        type: "user",
        uuid,
        parentUuid: uuid === "foreign" ? null : "command",
        ...(uuid === "inbox" ? { isMeta: true } : {}),
        message: {
          role: "user",
          content:
            uuid === "ordinary"
              ? "Discuss <local-command-stdout>Compacted </local-command-stdout>"
              : "<local-command-stdout>Compacted </local-command-stdout>",
        },
      })),
    ];
    writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const records = history.scan(file)._unsafeUnwrap();
    expect(
      records.filter((record) => record.type === "message").map((record) => record.id),
    ).toEqual(["inbox", "foreign", "ordinary"]);
    expect(records.find((record) => record.id === "inbox")).toMatchObject({
      inboxMessageIds: ["real-inbox"],
    });
  });
  it("keeps SDK-injected skill context private while preserving Skill activity and literal human text", () => {
    const dir = fixture();
    const file = join(dir, "root.jsonl");
    const body =
      "Base directory for this skill: /workspace/claude/platform-plugin/skills/boot-hooks\n\n# Boot hooks\n\n| Hook | Purpose |\n| setup | Install dependencies |\n<command-name>/boot-hooks</command-name>";
    const assistant = {
      type: "assistant",
      uuid: "skill-call",
      parentUuid: null,
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "skill-tool", name: "Skill", input: { skill: "boot-hooks" } },
        ],
      },
    };
    const result = {
      type: "user",
      uuid: "skill-result",
      parentUuid: "skill-call",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "skill-tool",
            content: "Launching skill: boot-hooks",
          },
        ],
      },
    };
    const injected = {
      type: "user",
      uuid: "skill-context",
      parentUuid: "skill-result",
      isMeta: true,
      turnCompanion: true,
      sourceToolUseID: "skill-tool",
      message: { role: "user", content: [{ type: "text", text: body }] },
    };
    const human = {
      type: "user",
      uuid: "human",
      parentUuid: "skill-context",
      message: injected.message,
    };
    const tracked = { ...injected, uuid: "tracked-human", parentUuid: "human" };
    const prefix = [assistant, result].map((row) => JSON.stringify(row)).join("\n") + "\n";
    const suffix = [injected, human, tracked].map((row) => JSON.stringify(row)).join("\n") + "\n";
    writeFileSync(file, prefix);
    const history = new ClaudeHistory(dir, "s", "2026-10-06T00:00:00Z");
    history
      .correlate("tracked-human", { messageIds: ["inbox"], operationId: "human" })
      ._unsafeUnwrap();
    history.scan(file)._unsafeUnwrap();
    appendFileSync(file, suffix);
    const records = history.scan(file)._unsafeUnwrap();
    expect(records[0]).toMatchObject({
      role: "assistant",
      content: [{ type: "tool_call", name: "Skill", callId: "skill-tool" }],
    });
    expect(records[1]).toMatchObject({
      role: "tool",
      content: [{ type: "tool_result", callId: "skill-tool" }],
    });
    expect(records[2]).toMatchObject({
      id: "skill-context",
      parentId: "skill-result",
      type: "event",
      eventType: "claude.native_metadata",
    });
    expect(JSON.stringify(records[2])).not.toContain(body);
    expect(records[3]).toMatchObject({ role: "user", content: [{ type: "text", text: body }] });
    expect(records[4]).toMatchObject({
      role: "user",
      inboxMessageIds: ["inbox"],
      content: [{ type: "text", text: body }],
    });
    expect(new ClaudeHistory(dir, "s", "2026-10-06T00:00:00Z").scan(file)._unsafeUnwrap()).toEqual(
      records,
    );
    expect(readFileSync(file, "utf8")).toBe(prefix + suffix);
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

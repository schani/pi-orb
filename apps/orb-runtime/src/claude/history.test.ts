import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeBootEntries } from "./boot-notification.ts";
import { ClaudeHistory, nativeHistoryFiles, type Provenance } from "./history.ts";
import { qualifyClaudeRestart } from "./restore.ts";

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
  it("retains a restart prompt receipt without duplicating its visible journal notice", () => {
    const dir = fixture();
    const file = join(dir, "root.jsonl");
    const history = new ClaudeHistory(dir, "session", "2026-10-06T00:00:00Z");
    history
      .correlate("boot-input", { messageIds: [], operationId: "boot-operation", boot: true })
      ._unsafeUnwrap();
    writeFileSync(
      file,
      `${JSON.stringify({ type: "user", uuid: "boot-input", message: { role: "user", content: "Continue from where you left off." } })}\n`,
    );
    const records = history.scan(file)._unsafeUnwrap();
    expect(records).toMatchObject([
      { id: "boot-input", type: "event", eventType: "claude.boot_receipt" },
    ]);
    expect(records[0]).not.toHaveProperty("content");
    expect(JSON.stringify(records)).not.toContain("Continue from where");
    expect(
      new ClaudeHistory(dir, "session", "2026-10-06T00:00:00Z").scan(file)._unsafeUnwrap(),
    ).toEqual(records);
  });
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

it.each([
  { system: false, messageIds: ["inbox"] },
  { messageIds: ["inbox"] },
  { system: true, messageIds: [] },
  { system: true, messageIds: ["one", "two"] },
  { system: true, messageIds: ["inbox"], boot: true },
  { system: true, messageIds: ["inbox"], boot: false },
  { system: true, messageIds: ["inbox"], compaction: true },
  { system: true, messageIds: ["inbox"], compaction: false },
  { system: true, messageIds: ["inbox"], sender: undefined },
  { system: true, messageIds: ["inbox"], boot: undefined },
])("rejects peer provenance without a singleton non-human receipt: %j", (invalid) => {
  const dir = fixture();
  const sender = { orbId: "11111111-1111-4111-8111-111111111111" };
  const provenance = { operationId: "op", sender, ...invalid };
  const history = new ClaudeHistory(dir, "session", "t");
  expect(history.correlate("peer", provenance as unknown as Provenance).isErr()).toBe(true);
  if (!Object.values(invalid).includes(undefined)) {
    writeFileSync(join(dir, "provenance.json"), JSON.stringify({ peer: provenance }));
    expect(new ClaudeHistory(dir, "session", "t").scan(null).isErr()).toBe(true);
  }
});

describe("consumed queued input", () => {
  const timestamp = "2026-10-15T22:23:02.522Z";
  const attachment = {
    type: "attachment",
    uuid: "attachment",
    sessionId: "session",
    attachment: {
      type: "queued_command",
      source_uuid: "input",
      delivery_id: "delivery",
      prompt: "PRIVATE",
    },
  };
  const consumed = {
    type: "queue-operation",
    operation: "remove",
    reason: "absorbed_mid_turn",
    commandUuid: "input",
    deliveryId: "delivery",
    sessionId: "session",
  };
  const state = { deliveries: { inbox: { uuid: "input", operationId: "op", submitted: true } } };
  const setup = (
    rows: unknown[],
    provenance: Provenance | null = { messageIds: ["inbox"], operationId: "op" },
  ) => {
    const dir = fixture();
    const path = join(dir, "root.jsonl");
    const source = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
    writeFileSync(path, source);
    const history = new ClaudeHistory(dir, "session", timestamp);
    if (provenance) history.correlate("input", provenance)._unsafeUnwrap();
    return { dir, path, source, history };
  };

  it("recovers a fully indexed root on first start with the existing input identity", () => {
    const f = setup([
      attachment,
      consumed,
      { type: "assistant", uuid: "final", message: { content: "done" } },
    ]);
    f.history.scan(f.path)._unsafeUnwrap();
    const indexPath = join(f.dir, "index.json");
    const index = JSON.parse(readFileSync(indexPath, "utf8"));
    const records = index.records.filter((record: { id: string }) => record.id !== "input");
    writeFileSync(indexPath, JSON.stringify({ ...index, records }));
    const history = new ClaudeHistory(f.dir, "session", "later");
    const view = history.scan(f.path)._unsafeUnwrap();
    expect(view.slice(0, records.length)).toEqual(records);
    expect(view).toHaveLength(records.length + 1);
    const receipt = view.find((record) => record.id === "input");
    expect(receipt).toMatchObject({
      id: "input",
      parentId: "final",
      type: "event",
      eventType: "claude.input_receipt",
      inboxMessageIds: ["inbox"],
      overflow: {
        sessionId: "session",
        operationId: "op",
        deliveryId: "delivery",
        attachmentId: "attachment",
        inputKind: "human",
      },
    });
    expect(receipt).not.toHaveProperty("content");
    expect(JSON.stringify(receipt)).not.toContain("PRIVATE");
    expect(qualifyClaudeRestart(state, view, "host")._unsafeUnwrap().interruptedOperations).toEqual(
      ["op"],
    );
    const reopened = new ClaudeHistory(f.dir, "session", "later still");
    expect(reopened.scan(f.path)._unsafeUnwrap()).toEqual(view);
    const suffix =
      JSON.stringify({ type: "assistant", uuid: "tail", message: { content: "tail" } }) + "\n";
    appendFileSync(f.path, suffix);
    expect(reopened.scan(f.path)._unsafeUnwrap().at(-1)?.id).toBe("tail");
    expect(reopened.view.find((record) => record.id === "input")).toEqual(receipt);
    expect(new ClaudeHistory(f.dir, "session", timestamp).scan(f.path)._unsafeUnwrap()).toEqual(
      reopened.view,
    );
    expect(readFileSync(f.path, "utf8")).toBe(f.source + suffix);
  });

  it.each([
    [attachment],
    [consumed, attachment],
    [attachment, { ...consumed, commandUuid: "wrong" }],
    [attachment, { ...consumed, deliveryId: "wrong" }],
    [attachment, { ...consumed, reason: "delivered_to_agent" }],
    [{ ...attachment, sessionId: "child" }, consumed],
    [attachment, { ...consumed, sessionId: "child" }],
    [{ ...attachment, isSidechain: true }, consumed],
    [attachment, { ...consumed, agentId: "child" }],
    [{ ...attachment, attachment: { ...attachment.attachment, source_uuid: "" } }, consumed],
    [
      { ...attachment, attachment: { ...attachment.attachment, delivery_id: "x".repeat(97) } },
      consumed,
    ],
  ])("does not receipt unconsumed or foreign proof: %j", (...rows) => {
    const f = setup(rows);
    f.history.scan(f.path)._unsafeUnwrap();
    expect(f.history.view.some((record) => record.id === "input")).toBe(false);
    expect(qualifyClaudeRestart(state, f.history.view, "host").isErr()).toBe(true);
  });

  it.each([false, true])(
    "rejects a same-ID attachment without consumption atomically (fingerprinted=%s)",
    (fingerprinted) => {
      const f = setup([{ ...attachment, uuid: "input" }], fingerprinted ? null : undefined);
      if (fingerprinted) {
        f.history.scan(f.path)._unsafeUnwrap();
        f.history.correlate("input", { messageIds: ["inbox"], operationId: "op" })._unsafeUnwrap();
      }
      const history = new ClaudeHistory(f.dir, "session", timestamp);
      const before = [...history.view];
      const indexPath = join(f.dir, "index.json");
      const saved = nativeHistoryFiles.read(indexPath);
      expect(history.scan(f.path)).toMatchObject({
        error: {
          type: "claude_history_error",
          message: "Consumed Claude input receipt proof conflicts.",
        },
      });
      expect(history.view).toEqual(before);
      expect(nativeHistoryFiles.read(indexPath)).toBe(saved);
      expect(readFileSync(f.path, "utf8")).toBe(f.source);
    },
  );

  it.each([
    [attachment, consumed, { ...consumed }],
    [attachment, consumed, { ...attachment, uuid: "other" }],
    [{ ...attachment, uuid: "input" }, consumed],
    [{ type: "assistant", uuid: "input", message: { content: "unrelated" } }, attachment, consumed],
  ])("fails closed atomically on ambiguous proof or unrelated UUID collision: %j", (...rows) => {
    const f = setup([{ type: "assistant", uuid: "baseline", message: { content: "before" } }]);
    const before = f.history.scan(f.path)._unsafeUnwrap();
    appendFileSync(f.path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    expect(f.history.scan(f.path).isErr()).toBe(true);
    expect(f.history.view).toEqual(before);
  });

  it.each([false, true])(
    "retains an ordinary input receipt without a duplicate (platform=%s)",
    (system) => {
      const f = setup([attachment], { messageIds: ["inbox"], operationId: "op", system });
      f.history.scan(f.path)._unsafeUnwrap();
      appendFileSync(
        f.path,
        JSON.stringify({ type: "user", uuid: "input", message: { content: "ordinary" } }) + "\n",
      );
      const ordinary = f.history
        .scan(f.path)
        ._unsafeUnwrap()
        .find((record) => record.id === "input");
      appendFileSync(f.path, JSON.stringify(consumed) + "\n");
      const view = f.history.scan(f.path)._unsafeUnwrap();
      expect(view.filter((record) => record.id === "input")).toEqual([ordinary]);
      expect(qualifyClaudeRestart(state, view, "host").isOk()).toBe(true);
    },
  );

  it.each([
    null,
    { messageIds: ["inbox"], operationId: "op", system: true },
    { messageIds: [], operationId: "op", boot: true },
    { messageIds: [], operationId: "op", compaction: true },
    {
      messageIds: ["inbox"],
      operationId: "op",
      system: true,
      sender: { orbId: "11111111-1111-4111-8111-111111111111" },
    },
  ] satisfies (Provenance | null)[])(
    "never grants human authority from native origin: %j",
    (provenance) => {
      const f = setup([attachment, consumed], provenance);
      const view = f.history.scan(f.path)._unsafeUnwrap();
      expect(view.some((record) => record.id === "input")).toBe(provenance !== null);
      expect(claudeBootEntries(view)).toEqual([]);
    },
  );

  it("waits for a complete removal and publishes nothing on failed receipt commit", () => {
    const f = setup([attachment]);
    const before = f.history.scan(f.path)._unsafeUnwrap();
    const indexPath = join(f.dir, "index.json");
    const saved = readFileSync(indexPath, "utf8");
    appendFileSync(f.path, JSON.stringify(consumed));
    expect(f.history.scan(f.path)._unsafeUnwrap()).toEqual(before);
    appendFileSync(f.path, "\n");
    const failed = new ClaudeHistory(f.dir, "session", timestamp, {
      ...nativeHistoryFiles,
      commit: () => {
        throw new Error("injected");
      },
    });
    expect(failed.scan(f.path).isErr()).toBe(true);
    expect(failed.view).toEqual(before);
    expect(readFileSync(indexPath, "utf8")).toBe(saved);
    expect(
      new ClaudeHistory(f.dir, "session", timestamp).scan(f.path)._unsafeUnwrap().at(-1)?.id,
    ).toBe("input");
  });
});

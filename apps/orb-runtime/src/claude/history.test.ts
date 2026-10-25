import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
    writeFileSync(
      file,
      `${JSON.stringify({ type: "user", uuid: "valid", message: { role: "user", content: "valid" } })}\n`,
    );
    expect(new ClaudeHistory(dir, "s", "2026-10-04T00:00:00Z").scan(file).isOk()).toBe(true);
    writeFileSync(join(dir, "index.json"), '{"records":null,"fingerprints":[]}');
    expect(
      new ClaudeHistory(dir, "s", "2026-10-04T00:00:00Z").scan(file)._unsafeUnwrapErr(),
    ).toEqual({
      type: "claude_history_error",
      message: "Malformed Claude history index.",
    });
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
  const setup = (rows: unknown[], provenance = true) => {
    const dir = fixture();
    const path = join(dir, "root.jsonl");
    const source = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
    writeFileSync(path, source);
    const history = new ClaudeHistory(dir, "session", "2026-10-15T22:23:02Z");
    if (provenance)
      history.correlate("input", { messageIds: ["inbox"], operationId: "op" })._unsafeUnwrap();
    return { dir, path, source, history, indexPath: join(dir, "index.json") };
  };

  it("backfills a fully indexed root once, preserving records, ancestry and native bytes", () => {
    const f = setup([
      attachment,
      consumed,
      { type: "assistant", uuid: "final", message: { content: "done" } },
    ]);
    f.history.scan(f.path)._unsafeUnwrap();
    const index = JSON.parse(readFileSync(f.indexPath, "utf8"));
    const records = index.records.filter((record: { id: string }) => record.id !== "input");
    writeFileSync(f.indexPath, JSON.stringify({ ...index, records }));
    const history = new ClaudeHistory(f.dir, "session", "later");
    const view = history.scan(f.path)._unsafeUnwrap();
    expect(view.slice(0, records.length)).toEqual(records);
    expect(view).toHaveLength(records.length + 1);
    const receipt = view.at(-1);
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
    expect(readFileSync(f.path, "utf8")).toBe(f.source);
  });

  it.each([false, true])(
    "matches the last equivalent boot delivery copy (reordered payload=%s)",
    (reordered) => {
      const first = {
        ...attachment,
        parentUuid: null,
        attachment: { ...attachment.attachment, isMeta: true, origin: { kind: "internal" } },
      };
      const f = setup([first], false);
      f.history
        .correlate("input", { messageIds: [], operationId: "host-marker", boot: true })
        ._unsafeUnwrap();
      const before = [...f.history.scan(f.path)._unsafeUnwrap()];
      const payload = reordered
        ? Object.fromEntries(Object.entries(first.attachment).reverse())
        : first.attachment;
      const copy = { ...first, uuid: "copy", parentUuid: "attachment", attachment: payload };
      const tail = [
        copy,
        consumed,
        { type: "assistant", uuid: "final", parentUuid: "copy", message: { content: "done" } },
      ];
      appendFileSync(f.path, tail.map((row) => JSON.stringify(row)).join("\n") + "\n");
      const native = readFileSync(f.path, "utf8");
      const view = f.history.scan(f.path)._unsafeUnwrap();
      expect(view.slice(0, before.length)).toEqual(before);
      expect(view.find((record) => record.id === "final")?.parentId).toBe("copy");
      expect(view.at(-1)).toMatchObject({
        id: "input",
        eventType: "claude.input_receipt",
        inboxMessageIds: [],
        overflow: {
          operationId: "host-marker",
          inputKind: "boot",
          attachmentId: "copy",
          attachmentLine: 2,
          consumptionLine: 3,
        },
      });
      expect(JSON.stringify(view.at(-1))).not.toContain("PRIVATE");
      const saved = readFileSync(f.indexPath, "utf8");
      expect(new ClaudeHistory(f.dir, "session", "later").scan(f.path)._unsafeUnwrap()).toEqual(
        view,
      );
      expect(readFileSync(f.indexPath, "utf8")).toBe(saved);
      expect(readFileSync(f.path, "utf8")).toBe(native);
    },
  );

  it.each([
    [[attachment], true],
    [[consumed, attachment], true],
    [[attachment, { ...consumed, commandUuid: "wrong" }], true],
    [[attachment, { ...consumed, deliveryId: "wrong" }], true],
    [[{ ...attachment, sessionId: "child" }, consumed], true],
    [[attachment, { ...consumed, sessionId: "child" }], true],
    [[{ ...attachment, isSidechain: true }, consumed], true],
    [[attachment, { ...consumed, agentId: "child" }], true],
    [[attachment, consumed], false],
  ])("requires root proof and saved provenance: %j / %s", (rows, provenance) => {
    const f = setup(rows, provenance);
    const view = f.history.scan(f.path)._unsafeUnwrap();
    expect(view.some((record) => record.id === "input")).toBe(false);
    expect(qualifyClaudeRestart(state, view, "host").isErr()).toBe(true);
  });

  it.each([
    { ...attachment.attachment, source_uuid: "other-input" },
    { ...attachment.attachment, delivery_id: "other-delivery" },
    { ...attachment.attachment, prompt: "DIFFERENT" },
    { ...attachment.attachment, isMeta: true },
    { ...attachment.attachment, origin: { kind: "human" } },
  ])("rejects conflicting delivery-copy payload atomically: %j", (payload) => {
    const f = setup([attachment]);
    const before = [...f.history.scan(f.path)._unsafeUnwrap()];
    const saved = readFileSync(f.indexPath, "utf8");
    const tail = [{ ...attachment, uuid: "copy", attachment: payload }, consumed];
    appendFileSync(f.path, tail.map((row) => JSON.stringify(row)).join("\n") + "\n");
    expect(f.history.scan(f.path).isErr()).toBe(true);
    expect(f.history.view).toEqual(before);
    expect(readFileSync(f.indexPath, "utf8")).toBe(saved);
  });

  it.each([
    [attachment, consumed, { ...consumed }],
    [attachment, consumed, { ...attachment, uuid: "other" }],
    [{ ...attachment, uuid: "input" }, consumed],
    [{ type: "assistant", uuid: "input", message: { content: "unrelated" } }, attachment, consumed],
  ])("rejects duplicate proof or unrelated UUID collisions: %j", (...rows) => {
    const f = setup(rows);
    expect(f.history.scan(f.path).isErr()).toBe(true);
    expect(f.history.view).toEqual([]);
  });

  it.each([false, true])("rejects unconsumed UUID collisions (indexed=%s)", (indexed) => {
    const f = setup([{ ...attachment, uuid: "input" }], !indexed);
    if (indexed) {
      f.history.scan(f.path)._unsafeUnwrap();
      f.history.correlate("input", { messageIds: ["inbox"], operationId: "op" })._unsafeUnwrap();
    }
    const before = [...f.history.view];
    const saved = nativeHistoryFiles.read(f.indexPath);
    expect(f.history.scan(f.path).isErr()).toBe(true);
    expect(f.history.view).toEqual(before);
    expect(nativeHistoryFiles.read(f.indexPath)).toBe(saved);
  });

  it("never rewrites an already committed receipt when a later copy appears", () => {
    const f = setup([attachment, consumed]);
    const before = [...f.history.scan(f.path)._unsafeUnwrap()];
    const saved = readFileSync(f.indexPath, "utf8");
    appendFileSync(f.path, JSON.stringify({ ...attachment, uuid: "later-copy" }) + "\n");
    const reopened = new ClaudeHistory(f.dir, "session", "later");
    const result = reopened.scan(f.path);
    expect(result.isErr() && result.error.message).toBe(
      "Consumed Claude input receipt proof conflicts: delivery copy follows consumption.",
    );
    expect(reopened.view).toEqual(before);
    expect(readFileSync(f.indexPath, "utf8")).toBe(saved);
  });

  it("ignores a child delivery copy when selecting root proof", () => {
    const f = setup([
      attachment,
      { ...attachment, sessionId: "child", uuid: "child-copy" },
      consumed,
    ]);
    expect(f.history.scan(f.path)._unsafeUnwrap().at(-1)).toMatchObject({
      id: "input",
      overflow: { attachmentId: "attachment", attachmentLine: 1, consumptionLine: 3 },
    });
  });

  it("publishes no receipt when its index commit fails", () => {
    const f = setup([attachment]);
    const before = f.history.scan(f.path)._unsafeUnwrap();
    const saved = readFileSync(f.indexPath, "utf8");
    appendFileSync(f.path, JSON.stringify(consumed) + "\n");
    const failed = new ClaudeHistory(f.dir, "session", "later", {
      ...nativeHistoryFiles,
      commit: () => {
        throw new Error("injected");
      },
    });
    expect(failed.scan(f.path).isErr()).toBe(true);
    expect(failed.view).toEqual(before);
    expect(readFileSync(f.indexPath, "utf8")).toBe(saved);
  });
});

import type { ContentBlock, EventRecord, HistoryRecord, MessageRecord } from "@pi-orb/protocol";
import { describe, expect, it } from "vitest";
import {
  extractHistorySearchText,
  historySearchQueryTerms,
  historySearchSnippet,
  historySearchTermFrequencies,
  tokenizeHistorySearchText,
} from "./history-search-text.ts";

const base = { id: "record", parentId: null, timestamp: "2026-10-23", overflow: {} };
const text = (value: string): Extract<ContentBlock, { type: "text" }> => ({
  type: "text",
  text: value,
});
const message = (content: ContentBlock[], extra: Partial<MessageRecord> = {}): MessageRecord => ({
  ...base,
  type: "message",
  role: "assistant",
  content,
  ...extra,
});
const event = (extra: Partial<EventRecord>): EventRecord => ({
  ...base,
  type: "event",
  eventType: "pi.custom_message",
  ...extra,
});

describe("history search public extraction", () => {
  it("keeps lossless public text without mutating source or indexing overflow", () => {
    const record = message(
      [
        { ...text("Café\u0000A\ud800"), overflow: { secret: "blocksecret" } },
        { type: "reasoning", text: "reasoningsecret" },
        { type: "reasoning", text: "redactedsecret", redacted: true },
        { type: "image", data: "imagesecret", url: "https://image.invalid" },
        { type: "other", contentType: "artifact", data: { text: "artifactsecret" } },
      ],
      { overflow: { native: { text: "nativesecret", children: ["childsecret"] } } },
    );
    const before = JSON.stringify(record);
    expect(extractHistorySearchText(record)).toBe("Café\u0000A\ud800");
    expect(JSON.stringify(record)).toBe(before);
    expect(
      extractHistorySearchText(
        message([text("Human")], {
          role: "user",
          inboxMessageIds: ["inbox"],
        }),
      ),
    ).toBe("Human");
  });

  it.each(["system", "developer"] as const)("excludes %s messages", (role) => {
    expect(extractHistorySearchText(message([text("secret")], { role }))).toBe("");
  });

  it("obeys native metadata and delivery visibility without crawling native payloads", () => {
    const native = { type: "user", isMeta: true, private: "private" };
    expect(
      extractHistorySearchText(
        message([text("skillsecret")], {
          role: "user",
          overflow: { native },
        }),
      ),
    ).toBe("");
    expect(
      extractHistorySearchText(
        message([text("scheduled public delivery")], {
          role: "user",
          overflow: {
            native: {
              ...native,
              origin: {
                kind: "task-notification",
                subkind: "scheduled-trigger",
              },
            },
          },
        }),
      ),
    ).toBe("scheduled public delivery");
    expect(
      extractHistorySearchText(
        event({
          eventType: "claude.auth",
          content: [text("authsecret")],
          custom: { customType: "auth", display: true },
        }),
      ),
    ).toBe("");
    expect(
      extractHistorySearchText(
        event({
          eventType: "claude.task_notification",
          content: [text("hidden duplicate")],
        }),
      ),
    ).toBe("");
  });

  it("excludes native command echoes but keeps human-authored literal text", () => {
    const content = "<local-command-stdout>Compacted</local-command-stdout>";
    const record = message([text(content)], {
      role: "user",
      overflow: {
        native: {
          type: "user",
          message: { role: "user", content },
        },
      },
    });
    expect(extractHistorySearchText(record)).toBe("");
    expect(extractHistorySearchText({ ...record, inboxMessageIds: ["human"] })).toBe(content);
    expect(
      extractHistorySearchText({
        ...record,
        content: [text(`Discuss ${content}`)],
        overflow: {
          native: { type: "user", message: { role: "user", content: `Discuss ${content}` } },
        },
      }),
    ).toBe(`Discuss ${content}`);
    expect(
      extractHistorySearchText({
        ...record,
        overflow: { native: { type: "message", message: { role: "user", content } } },
      }),
    ).toBe(content);
    expect(
      extractHistorySearchText(
        event({
          eventType: "claude.compact_command",
          content: [text("hidden command")],
        }),
      ),
    ).toBe("");
  });

  it("includes displayed custom, peer, alerts and compaction summaries only", () => {
    expect(extractHistorySearchText(event({ content: [text("hidden custom")] }))).toBe("");
    expect(
      extractHistorySearchText(
        event({
          content: [text("visible custom")],
          custom: { customType: "public", display: true },
        }),
      ),
    ).toBe("visible custom");
    for (const eventType of ["orb.message", "agent.settings_fallback", "agent.compaction"]) {
      expect(extractHistorySearchText(event({ eventType, content: [text(eventType)] }))).toBe(
        eventType,
      );
    }
    expect(
      extractHistorySearchText(
        event({
          eventType: "orb.alert",
          alert: { message: "visible alert", requestId: "secret-id" },
          overflow: { text: "hidden alert" },
        }),
      ),
    ).toBe("visible alert");
    const compact: HistoryRecord = {
      ...base,
      type: "compaction",
      summary: [text("public summary"), { type: "reasoning", text: "private summary" }],
    };
    expect(extractHistorySearchText(compact)).toBe("public summary");
  });

  it("indexes public child notice selection, not task prompts or unselected fields", () => {
    expect(
      extractHistorySearchText(
        event({
          content: [text("hidden child transcript")],
          subagentTask: { id: "id", prompt: "hidden prompt", description: "hidden task" },
          subagent: {
            kind: "notification",
            description: "child description",
            status: "failed",
            message: "hidden message",
            error: "public failure",
            resultPreview: "hidden preview",
          },
        }),
      ),
    ).toBe("child description\nfailed\npublic failure");
    expect(
      extractHistorySearchText(
        event({
          subagent: { kind: "notification", message: "public child notice" },
        }),
      ),
    ).toBe("public child notice");
    expect(
      extractHistorySearchText(
        event({
          subagent: {
            kind: "workspace_notice",
            notice: "public workspace",
            message: "hidden message",
          },
        }),
      ),
    ).toBe("public workspace");
    expect(
      extractHistorySearchText(
        event({
          subagent: { kind: "update", message: "public update", resultPreview: "hidden preview" },
        }),
      ),
    ).toBe("public update");
  });

  it("uses public tool arguments, excluding private bash fields and result metadata", () => {
    const record = message([
      {
        type: "tool_call",
        callId: "c",
        name: "bash",
        arguments: {
          command: "echo public-command",
          private: "private-argument",
        },
      },
      { type: "tool_call", callId: "r", name: "read", arguments: { path: "public/path" } },
      {
        type: "tool_result",
        callId: "c",
        content: [
          text("public result"),
          { type: "reasoning", text: "private-result" },
          { type: "image", data: "private-image" },
          { type: "other", contentType: "artifact", data: "private-artifact" },
        ],
        overflow: { result: "private-overflow" },
        nestedCalls: {
          complete: true,
          calls: [
            {
              id: "child",
              name: "read",
              status: "ok",
              arguments: { path: "private-child" },
            },
          ],
        },
      },
    ]);
    const extracted = extractHistorySearchText(record);
    for (const visible of ["bash", "echo public-command", "read", "public/path", "public result"]) {
      expect(extracted).toContain(visible);
    }
    expect(extracted).not.toContain("private");
  });

  it("bounds tool excerpts but not ordinary assistant text", () => {
    const long = "x".repeat(10_000);
    expect(extractHistorySearchText(message([text(long)]))).toBe(long);
    const extracted = extractHistorySearchText(
      message([
        { type: "tool_call", callId: "c", name: "read", arguments: { path: `${long}tail-secret` } },
        { type: "tool_result", callId: "c", content: [text(long), text("tail-secret")] },
      ]),
    );
    expect(extracted.length).toBeLessThanOrEqual(4_020);
    expect(extracted).not.toContain("tail-secret");
  });
});

describe("history search tokens", () => {
  it("normalizes Unicode and case deterministically with NUL and punctuation separators", () => {
    expect(
      tokenizeHistorySearchText("CAFÉ cafe\u0301 ＦＯＯ foo\u0000BAR Ελληνικά 中文 １２ a_b"),
    ).toEqual(["café", "café", "foo", "foo", "bar", "ελληνικά", "中文", "12", "a", "b"]);
    expect(tokenizeHistorySearchText("\u0000\ud800 !!! \u0301")).toEqual([]);
  });

  it("counts safe tokens and deduplicates query terms in first-occurrence order", () => {
    const result = historySearchTermFrequencies("Foo foo BAR constructor __proto__ \u0000 ＦＯＯ");
    expect(result.tokenCount).toBe(6);
    expect(Object.entries(result.termFrequencies)).toEqual([
      ["foo", 3],
      ["bar", 1],
      ["constructor", 1],
      ["proto", 1],
    ]);
    expect(JSON.parse(JSON.stringify(result.termFrequencies))).toEqual({
      foo: 3,
      bar: 1,
      constructor: 1,
      proto: 1,
    });
    expect(historySearchQueryTerms("Foo BAR foo ＢＡＲ")).toEqual(["foo", "bar"]);
    expect(historySearchTermFrequencies("!!!")).toEqual({ tokenCount: 0, termFrequencies: {} });
  });
});

describe("history search snippets", () => {
  it("preserves short source strings and caps long excerpts around a matching token", () => {
    expect(historySearchSnippet("Café\u0000source", ["café"])).toBe("Café\u0000source");
    const source = `${"before ".repeat(150)}ＣＡＦÉ target ${"after ".repeat(150)}`;
    const snippet = historySearchSnippet(source, ["café"]);
    expect(snippet.length).toBeLessThanOrEqual(500);
    expect(snippet).toContain("ＣＡＦÉ target");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet.indexOf("ＣＡＦÉ")).toBeGreaterThan(200);
    expect(snippet.indexOf("ＣＡＦÉ")).toBeLessThan(300);
  });

  it("matches whole tokens rather than substrings and handles normalization expansion", () => {
    const source = `partial ${"padding ".repeat(150)} art end`;
    expect(historySearchSnippet(source, ["art"])).toContain(" art end");
    expect(historySearchSnippet(`${"padding ".repeat(150)} ½ end`, ["2"])).toContain("½ end");
  });

  it.each([
    ["enclosed letter", "Ⓐ", "a"],
    ["enclosed word", "🄰ⒷⒸ", "abc"],
    ["ligature", "oﬃce", "office"],
    ["compatibility unit", "㎏", "kg"],
    ["combining marks", "Ⓐ\u0301", "á"],
    ["combining ligature", "ﬀe\u0301", "ffé"],
    ["multiple normalized terms", "Ⓐ/oﬃce/Ⓑ\u0301", "office"],
    ["symbol expansion", "ﷺ", "وسلم"],
  ])("finds %s after a long prefix without changing the source", (_name, target, query) => {
    const prefix = "padding ".repeat(150);
    const source = `${prefix}\u0000${target} MiXeD ${"after ".repeat(150)}`;
    const snippet = historySearchSnippet(source, historySearchQueryTerms(query));
    expect(tokenizeHistorySearchText(source)).toContain(historySearchQueryTerms(query)[0]);
    expect(snippet.length).toBeLessThanOrEqual(500);
    expect(snippet).toContain(`\u0000${target} MiXeD`);
    expect(source).toBe(`${prefix}\u0000${target} MiXeD ${"after ".repeat(150)}`);
  });

  it.each([
    ["ligature expansion", "ﬃ ".repeat(400)],
    ["symbol expansion", "ﷺ ".repeat(150)],
    ["case expansion", "İ ".repeat(500)],
    ["combining contraction", "e\u0301 ".repeat(500)],
    ["supplementary normalization", "🄰 ".repeat(500)],
  ])("maps matches back to source after %s", (_name, prefix) => {
    const target = "Ⓐ\u0301/oﬃce MiXeD";
    const source = `${prefix}${target} ${"after ".repeat(150)}`;
    const snippet = historySearchSnippet(source, ["office"]);
    expect(snippet.length).toBeLessThanOrEqual(500);
    expect(snippet).toContain(target);
    expect(snippet).not.toMatch(/[\uD800-\uDFFF]/u);
    expect(snippet.indexOf(target)).toBeGreaterThan(200);
    expect(snippet.indexOf(target)).toBeLessThan(300);
  });

  it("falls back to the beginning, including for empty queries, without splitting surrogate pairs", () => {
    const source = "😀".repeat(600);
    for (const terms of [[], ["missing"]]) {
      const snippet = historySearchSnippet(source, terms);
      expect(snippet.length).toBeLessThanOrEqual(500);
      expect(snippet.startsWith("😀")).toBe(true);
      expect(snippet.endsWith("…")).toBe(true);
      expect(snippet).not.toMatch(/[\uD800-\uDFFF]/u);
    }
    expect(historySearchSnippet("", [])).toBe("");
  });
});

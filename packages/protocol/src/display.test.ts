import { describe, expect, it } from "vitest";
import {
  capHeadline,
  createDisplayRecordProjector,
  projectDisplayRecord,
  projectDisplayRecords,
  projectRecordDetail,
  projectRecordImage,
} from "./display.ts";
import type { HistoryRecord } from "./history.ts";

const secret = "HIDDEN_BODY_CANARY";
const record: HistoryRecord = {
  id: "r1",
  parentId: "r0",
  timestamp: "t",
  type: "message",
  role: "assistant",
  overflow: { native: secret },
  content: [
    { type: "text", text: "Visible answer", overflow: { native: secret } },
    { type: "reasoning", text: secret },
    {
      type: "tool_call",
      callId: "c1",
      name: "bash",
      arguments: { command: "echo visible", hidden: secret },
    },
    {
      type: "tool_result",
      callId: "c1",
      content: [
        { type: "text", text: secret },
        { type: "image", mediaType: "image/png", data: secret },
      ],
    },
  ],
};

describe("browser display projection", () => {
  it.each(["bash", "codemode"])(
    "projects bounded %s code without fetching or changing detail",
    (name) => {
      for (const code of ["  echo first\n\techo second  ", "😀".repeat(400), "x".repeat(1024)]) {
        const arguments_ = {
          [name === "bash" ? "command" : "code"]: code,
          token: secret,
          timeout: 30,
        };
        const source: HistoryRecord = {
          ...record,
          content: [{ type: "tool_call", callId: "c", name, arguments: arguments_ }],
        };
        const projected = projectDisplayRecord(source);
        expect(projected).toMatchObject({ content: [{ code: capHeadline(code), headline: null }] });
        expect(Buffer.byteLength(capHeadline(code))).toBeLessThanOrEqual(1024);
        expect(capHeadline(code)).not.toContain("�");
        expect(JSON.stringify(projected)).not.toContain(secret);
        expect(projectRecordDetail(source, "r1:0")).toEqual({
          type: "tool_call",
          arguments: name === "bash" ? { command: code } : arguments_,
        });
        const project = createDisplayRecordProjector();
        expect(project(source)).toEqual(projectDisplayRecords([source])[0]);
      }
    },
  );
  it("omits code for empty, malformed, unrelated, native and private child data", () => {
    for (const name of ["bash", "codemode", "get_subagent_result", "commands", "functions.bash"]) {
      for (const value of ["", " \n\t", 3, [], { code: secret }]) {
        const source: HistoryRecord = {
          ...record,
          content: [
            {
              type: "tool_call",
              callId: "c",
              name,
              arguments: { code: value, command: value },
              overflow: { code: secret },
            },
          ],
        };
        const projected = projectDisplayRecord(source);
        if (projected.type === "message") expect(projected.content[0]).not.toHaveProperty("code");
      }
    }
    for (const name of ["get_subagent_result", "commands", "functions.bash", "mcp__codemode"]) {
      const source: HistoryRecord = {
        ...record,
        content: [
          { type: "tool_call", callId: "c", name, arguments: { code: secret, command: secret } },
        ],
      };
      const projected = projectDisplayRecord(source);
      if (projected.type === "message") expect(projected.content[0]).not.toHaveProperty("code");
    }
    const privateEvent: HistoryRecord = {
      id: "private",
      parentId: null,
      timestamp: "t",
      type: "event",
      eventType: "pi.custom",
      overflow: {},
      content: [{ type: "tool_call", callId: "c", name: "codemode", arguments: { code: secret } }],
    };
    expect(JSON.stringify(projectDisplayRecord(privateEvent))).not.toContain(secret);
  });
  it.each(["", " \n\t "])(
    "omits empty public reasoning %j without changing identity or detail indices",
    (text) => {
      const source: HistoryRecord = {
        ...record,
        content: [
          { type: "reasoning", text, overflow: { native: { type: "thinking", thinking: text } } },
          { type: "tool_call", callId: "child", name: "subagent", arguments: { prompt: "task" } },
        ],
      };
      const before = structuredClone(source);
      expect(projectDisplayRecord(source)).toMatchObject({
        id: source.id,
        parentId: source.parentId,
        content: [{ type: "tool_call", detailKey: "r1:1" }],
      });
      expect(projectRecordDetail(source, "r1:0")).toEqual({ type: "reasoning", text });
      expect(projectRecordDetail(source, "r1:1")).toEqual({
        type: "tool_call",
        arguments: { prompt: "task" },
      });
      expect(source).toEqual(before);
      const outcome: HistoryRecord = {
        ...record,
        id: "outcome",
        parentId: "r1",
        role: "tool",
        content: [
          { type: "reasoning", text },
          { type: "tool_result", callId: "child", content: [{ type: "text", text: "Completed" }] },
        ],
      };
      const batch = projectDisplayRecords([source, outcome]);
      expect(batch[1]).toMatchObject({
        content: [{ type: "tool_result", headline: null, detailKey: "outcome:1" }],
      });
      const live = createDisplayRecordProjector();
      expect([live(source), live(outcome)]).toEqual(batch);
    },
  );

  it("preserves identity-only records, redacted notices and headingless public bodies", () => {
    const empty: HistoryRecord = { ...record, content: [{ type: "reasoning", text: "" }] };
    expect(projectDisplayRecord(empty)).toMatchObject({ id: "r1", parentId: "r0", content: [] });
    const visible: HistoryRecord = {
      ...record,
      content: [
        { type: "reasoning", text: "Plain public reasoning" },
        { type: "reasoning", text: "", redacted: true },
      ],
    };
    expect(projectDisplayRecord(visible)).toMatchObject({
      content: [
        { type: "reasoning", headline: "", detailKey: "r1:0" },
        { type: "reasoning", headline: "", detailKey: "r1:1", redacted: true },
      ],
    });
  });
  it("projects only capped reasoning headings and hides redacted headings", () => {
    const source: HistoryRecord = {
      ...record,
      content: [
        { type: "reasoning", text: "# Inspect files\n\nHIDDEN_BODY_CANARY\n\n**Choose fix**" },
        { type: "reasoning", text: "# REDACTED_HEADING\nHIDDEN_BODY_CANARY", redacted: true },
      ],
    };
    const projected = projectDisplayRecord(source);
    expect(projected).toMatchObject({
      content: [
        { type: "reasoning", headline: "Inspect files · Choose fix", detailKey: "r1:0" },
        { type: "reasoning", headline: "", detailKey: "r1:1", redacted: true },
      ],
    });
    expect(JSON.stringify(projected)).not.toContain(secret);
    expect(JSON.stringify(projected)).not.toContain("REDACTED_HEADING");
  });
  it("keeps a hidden boot baseline as an untyped custom event without native data", () => {
    const baseline: HistoryRecord = {
      id: "boot",
      parentId: null,
      timestamp: "t",
      type: "event",
      eventType: "pi.custom",
      overflow: { native: { customType: "pi-orb.boot", data: { incarnation: "1" } } },
    };
    expect(projectDisplayRecord(baseline)).toEqual({
      id: "boot",
      parentId: null,
      timestamp: "t",
      type: "event",
      eventType: "pi.custom",
    });
  });
  it("retains ordered identity and every call without undisplayed bodies or native data", () => {
    const projected = projectDisplayRecord(record);
    expect(projected).toMatchObject({
      id: "r1",
      parentId: "r0",
      content: [
        { type: "text", text: "Visible answer" },
        { type: "reasoning", detailKey: "r1:1" },
        { type: "tool_call", callId: "c1", detailKey: "r1:2" },
        {
          type: "tool_result",
          callId: "c1",
          detailKey: "r1:3",
          hasImages: true,
        },
      ],
    });
    expect(JSON.stringify(projected)).not.toContain(secret);
    expect(projectRecordDetail(record, "r1:2")).toEqual({
      type: "tool_call",
      arguments: { command: "echo visible" },
    });
    expect(projectRecordDetail(record, "r1:3")).toMatchObject({
      type: "tool_result",
      content: [
        { type: "text", text: secret },
        { type: "image", mediaType: "image/png", imageRef: "r1:3:1" },
      ],
    });
    expect(JSON.stringify(projectRecordDetail(record, "r1:3"))).not.toContain('"data"');
  });

  it("projects all 30 calls in realistic HTTP/WS envelopes with bounded headlines", () => {
    const calls: HistoryRecord[] = Array.from({ length: 30 }, (_, index) => ({
      id: `018fc90a-2a8e-7f22-b4a0-${String(index).padStart(12, "0")}`,
      parentId:
        index === 0 ? null : `018fc90a-2a8e-7f22-b4a0-${String(index - 1).padStart(12, "0")}`,
      timestamp: "2026-10-02T12:12:12.000Z",
      type: "message" as const,
      role: "assistant" as const,
      overflow: { native: secret },
      content: [
        {
          type: "tool_call" as const,
          callId: `call_${String(index).padStart(12, "0")}`,
          name: "read",
          arguments: {
            path: `/workspace/repo/src/${String(index).padStart(3, "0")}.ts`,
            hidden: secret,
          },
        },
      ],
    }));
    const projected = calls.map(projectDisplayRecord);
    const http = JSON.stringify({
      orbId: "orb-018fc90a-2a8e-7f22-b4a0",
      session: { id: "session-018fc90a-2a8e" },
      records: projected,
      cursor: projected.at(-1)?.id,
      headId: projected.at(-1)?.id,
    });
    const ws = JSON.stringify(
      projected.map((item) => ({
        v: 1,
        type: "history.record",
        at: "2026-10-02T12:12:12.000Z",
        record: item,
        retiredBlockIds: [],
        headId: item.id,
      })),
    );
    expect(
      projected.flatMap((item) =>
        item.type === "message" ? item.content.filter((block) => block.type === "tool_call") : [],
      ),
    ).toHaveLength(30);
    expect(http).not.toContain(secret);
    expect(ws).not.toContain(secret);
    expect(Buffer.byteLength(http)).toBeLessThan(20_000);
    expect(Buffer.byteLength(ws)).toBeLessThan(25_000);
  });

  it("omits an edit patch from detail while preserving its summary diff counts", () => {
    const edit: HistoryRecord = {
      id: "edit-result",
      parentId: null,
      timestamp: "t",
      type: "message",
      role: "tool",
      overflow: {},
      content: [
        {
          type: "tool_result",
          callId: "edit-call",
          content: [],
          patch: `--- a/file\n+++ b/file\n-${secret}\n+replacement\n`,
        },
      ],
    };
    expect(projectDisplayRecord(edit)).toMatchObject({
      content: [{ type: "tool_result", added: 1, removed: 1 }],
    });
    expect(projectRecordDetail(edit, "edit-result:0")).toEqual({
      type: "tool_result",
      content: [],
    });
    expect(JSON.stringify(projectRecordDetail(edit, "edit-result:0"))).not.toContain(secret);
  });

  it("projects bash's displayed command only, but retains unknown and read tool arguments", () => {
    for (const [index, name, args, expected] of [
      [
        0,
        "bash",
        { command: "echo visible", timeout: 3000, hidden: secret },
        { command: "echo visible" },
      ],
      [1, "bash", { timeout: 3000, hidden: secret }, {}],
      [
        2,
        "read",
        { path: "/file", offset: 2, hidden: secret },
        { path: "/file", offset: 2, hidden: secret },
      ],
      [3, "other_tool", { query: "visible", hidden: secret }, { query: "visible", hidden: secret }],
    ] as const) {
      const source: HistoryRecord = {
        id: `tool-${index}`,
        parentId: null,
        timestamp: "t",
        type: "message",
        role: "assistant",
        overflow: {},
        content: [{ type: "tool_call", callId: `call-${index}`, name, arguments: args }],
      };
      expect(projectRecordDetail(source, `${source.id}:0`)).toEqual({
        type: "tool_call",
        arguments: expected,
      });
    }
  });

  it("drops unrendered result leaves without shifting image indexes", () => {
    const source: HistoryRecord = {
      id: "mixed-result",
      parentId: null,
      timestamp: "t",
      type: "message",
      role: "tool",
      overflow: {},
      content: [
        {
          type: "tool_result",
          callId: "c",
          content: [{ type: "other", contentType: "blob", data: secret }],
        },
        {
          type: "tool_result",
          callId: "d",
          content: [
            { type: "text", text: "visible" },
            { type: "image", mediaType: "image/png", data: "image-data" },
            { type: "other", contentType: "blob", data: secret },
          ],
        },
        {
          type: "tool_result",
          callId: "e",
          content: [
            { type: "other", contentType: "hidden-before", data: secret },
            { type: "text", text: "visible middle" },
            { type: "other", contentType: "hidden-middle", data: secret },
            { type: "image", mediaType: "image/png", data: "second-image" },
          ],
        },
      ],
    };
    expect(projectRecordDetail(source, "mixed-result:0")).toEqual({
      type: "tool_result",
      content: [],
    });
    expect(projectRecordDetail(source, "mixed-result:1")).toEqual({
      type: "tool_result",
      content: [
        { type: "text", text: "visible" },
        { type: "image", mediaType: "image/png", imageRef: "mixed-result:1:1" },
      ],
    });
    expect(projectRecordImage(source, "mixed-result:1", 1)).toEqual({
      mediaType: "image/png",
      data: "image-data",
    });
    expect(projectRecordDetail(source, "mixed-result:2")).toEqual({
      type: "tool_result",
      content: [
        { type: "text", text: "visible middle" },
        { type: "image", mediaType: "image/png", imageRef: "mixed-result:2:3" },
      ],
    });
    expect(JSON.stringify(projectRecordDetail(source, "mixed-result:2"))).not.toMatch(
      /hidden-before|hidden-middle|HIDDEN_BODY_CANARY/,
    );
    expect(projectRecordImage(source, "mixed-result:2", 3)).toEqual({
      mediaType: "image/png",
      data: "second-image",
    });
  });

  it("keeps URL-backed images out of summaries but exposes safe URLs in requested details", () => {
    const source: HistoryRecord = {
      id: "url",
      parentId: null,
      timestamp: "t",
      type: "message",
      role: "user",
      overflow: {},
      content: [
        {
          type: "image",
          url: "https://images.example.test/example.png",
          mediaType: "image/png",
        },
      ],
    };
    expect(JSON.stringify(projectDisplayRecord(source))).not.toContain("images.example.test");
    expect(projectRecordDetail(source, "url:0")).toMatchObject({
      type: "image",
      url: "https://images.example.test/example.png",
    });
    expect(projectRecordImage(source, "url:0", 0)).toBeNull();
    source.content[0] = { type: "image", url: "data:image/png;base64,SECRET" };
    expect(JSON.stringify(projectRecordDetail(source, "url:0"))).not.toContain("SECRET");
  });

  it("projects only the failure classifier and provider needed by the visible error", () => {
    const failure: HistoryRecord = {
      id: "fail",
      parentId: null,
      timestamp: "t",
      type: "message",
      role: "assistant",
      overflow: { native: secret },
      content: [],
      finishReason: "error",
      model: { provider: "openai-codex", id: secret },
      failure: {
        message: "connection failed",
        diagnostics: ["provider_transport_failure", secret],
        context: { code: secret },
      },
    };
    expect(projectDisplayRecord(failure)).toMatchObject({
      type: "message",
      model: { provider: "openai-codex" },
      failure: { message: "connection failed", providerTransportFailure: true },
    });
    expect(JSON.stringify(projectDisplayRecord(failure))).not.toContain(secret);
  });

  it("keeps hidden subagent receipts and compaction out of summaries", () => {
    const event: HistoryRecord = {
      id: "event",
      parentId: "r1",
      timestamp: "t",
      type: "event",
      eventType: "pi.custom_message",
      overflow: { native: secret },
      custom: { customType: "subagent", display: true },
      subagent: {
        kind: "notification",
        description: "task",
        resultPreview: secret,
        message: secret,
      },
    };
    const compact: HistoryRecord = {
      id: "compact",
      parentId: "event",
      timestamp: "t",
      type: "compaction",
      overflow: {},
      summary: [{ type: "text", text: secret }],
    };
    expect(
      JSON.stringify([projectDisplayRecord(event), projectDisplayRecord(compact)]),
    ).not.toContain(secret);
    expect(projectRecordDetail(event, "event:subagent")).toMatchObject({
      type: "subagent",
      resultPreview: secret,
    });
    expect(projectRecordDetail(compact, "compact:summary")).toMatchObject({
      type: "compaction",
      text: secret,
    });
  });

  it("does not transmit mapped subagent notification content until its detail is requested", () => {
    const notification: HistoryRecord = {
      id: "subagent-notification-record",
      parentId: "r1",
      timestamp: "2026-10-02T12:12:12.000Z",
      type: "event",
      eventType: "pi.custom_message",
      overflow: { native: "NATIVE_CANARY" },
      custom: { customType: "subagent-notification", display: true },
      content: [
        {
          type: "text",
          text: `<task-notification>RAW_BODY_CANARY${"x".repeat(20_000)}</task-notification>`,
        },
      ],
      subagent: {
        kind: "notification",
        id: "child-1",
        description: "Check deployment",
        status: "completed",
        message: "DETAIL_BODY_CANARY",
        resultPreview: "Result preview",
        durationMs: 4200,
      },
    };
    const summary = projectDisplayRecord(notification);
    expect(summary).toMatchObject({
      id: notification.id,
      eventType: "pi.custom_message",
      subagent: {
        kind: "notification",
        id: "child-1",
        description: "Check deployment",
        status: "completed",
        detailKey: `${notification.id}:subagent`,
      },
    });
    expect(JSON.stringify(summary)).not.toMatch(/NATIVE_CANARY|RAW_BODY_CANARY|DETAIL_BODY_CANARY/);
    expect(summary).not.toHaveProperty("content");
    expect(projectRecordDetail(notification, `${notification.id}:subagent`)).toEqual({
      type: "subagent",
      resultPreview: "Result preview",
      durationMs: 4200,
    });
  });

  it("projects only the body the subagent renderer selects for each kind", () => {
    const hidden = (name: string) => `${name}_HIDDEN_CANARY_${"x".repeat(20_000)}`;
    const cases = [
      {
        kind: "update" as const,
        fields: {
          message: "  Update text  ",
          notice: hidden("notice"),
          error: hidden("error"),
          resultPreview: hidden("result"),
        },
        expected: { message: "  Update text  " },
      },
      {
        kind: "workspace_notice" as const,
        fields: {
          message: hidden("message"),
          notice: "  Workspace text  ",
          error: hidden("error"),
          resultPreview: hidden("result"),
        },
        expected: { notice: "  Workspace text  " },
      },
      {
        kind: "notification" as const,
        fields: {
          message: hidden("message"),
          notice: hidden("notice"),
          error: "  Error text  ",
          resultPreview: hidden("result"),
        },
        expected: { error: "  Error text  " },
      },
      {
        kind: "notification" as const,
        fields: {
          message: hidden("message"),
          notice: hidden("notice"),
          error: " \n ",
          resultPreview: "  Result text  ",
        },
        expected: { resultPreview: "  Result text  " },
      },
      {
        kind: "notification" as const,
        fields: {
          message: hidden("message"),
          notice: hidden("notice"),
          error: " \n ",
          resultPreview: "  ",
        },
        expected: {},
      },
      {
        kind: "update" as const,
        fields: {
          message: " \n ",
          notice: hidden("notice"),
          error: hidden("error"),
          resultPreview: hidden("result"),
        },
        expected: {},
      },
      {
        kind: "workspace_notice" as const,
        fields: {
          message: hidden("message"),
          notice: " \n ",
          error: hidden("error"),
          resultPreview: hidden("result"),
        },
        expected: {},
      },
    ];
    for (const [index, { kind, fields, expected }] of cases.entries()) {
      const source: HistoryRecord = {
        id: `subagent-${index}`,
        parentId: null,
        timestamp: "t",
        type: "event",
        eventType: "pi.custom_message",
        overflow: {},
        subagent: { kind, ...fields, durationMs: 1234 },
      };
      const detail = projectRecordDetail(source, `${source.id}:subagent`);
      expect(detail).toEqual({
        type: "subagent",
        ...expected,
        durationMs: 1234,
      });
      expect(JSON.stringify(detail)).not.toContain("HIDDEN_CANARY");
    }
  });

  it("omits durations the subagent renderer cannot display", () => {
    for (const durationMs of [-1, Number.NaN]) {
      const source: HistoryRecord = {
        id: "subagent-duration",
        parentId: null,
        timestamp: "t",
        type: "event",
        eventType: "pi.custom_message",
        overflow: {},
        subagent: { kind: "update", message: "Visible", durationMs },
      };
      expect(projectRecordDetail(source, `${source.id}:subagent`)).toEqual({
        type: "subagent",
        message: "Visible",
      });
    }
  });

  it("keeps clipped read targets distinct while repeats share identity", () => {
    const prefix = "/" + "a".repeat(1100);
    const make = (path: string): HistoryRecord => ({
      id: "r",
      parentId: null,
      timestamp: "t",
      type: "message",
      role: "assistant",
      overflow: {},
      content: [
        {
          type: "tool_call",
          callId: "c",
          name: "read",
          arguments: { path, offset: 2, limit: 5 },
        },
      ],
    });
    const first = projectDisplayRecord(make(`${prefix}one`));
    const second = projectDisplayRecord(make(`${prefix}two`));
    const third = projectDisplayRecord(make(`${prefix}one`));
    if (first.type !== "message" || second.type !== "message" || third.type !== "message")
      throw new Error("wrong fixture");
    const a = first.content[0];
    const b = second.content[0];
    const c = third.content[0];
    if (a?.type !== "tool_call" || b?.type !== "tool_call" || c?.type !== "tool_call")
      throw new Error("wrong fixture");
    expect(a.headline).toBe(b.headline);
    expect(a.targetId).not.toBe(b.targetId);
    expect(a.targetId).toBe(c.targetId);
    expect(a).toMatchObject({ offset: 2, limit: 5 });
  });

  it("caps UTF-8 headline including ellipsis at 1024 and preserves exact boundary", () => {
    expect(capHeadline("a".repeat(1024))).toBe("a".repeat(1024));
    expect(capHeadline("😀".repeat(256) + "x")).toBe("😀".repeat(255) + "…");
    expect(Buffer.byteLength(capHeadline("😀".repeat(300)), "utf8")).toBeLessThanOrEqual(1024);
  });
});

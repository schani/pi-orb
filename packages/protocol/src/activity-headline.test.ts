import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  ActivityHeadlineResponseSchema,
  type ContentBlock,
  createDisplayRecordProjector,
  DisplayRecordSchema,
  getActivityHeadlineSource,
  type HistoryRecord,
  type JsonValue,
  projectDisplayRecords,
} from "./index.ts";

const message = (
  id: string,
  content: ContentBlock[],
  role: "assistant" | "tool" | "user" = "assistant",
  parentId: string | null = null,
): HistoryRecord => ({
  id,
  parentId,
  timestamp: "t",
  overflow: { secret: "SECRET" },
  type: "message",
  role,
  content,
});
const call = (name: string, arguments_: Record<string, JsonValue> = {}): ContentBlock => ({
  type: "tool_call",
  callId: "c",
  name,
  arguments: arguments_,
});
const result = (text: string): ContentBlock => ({
  type: "tool_result",
  callId: "c",
  isError: true,
  content: [
    { type: "text", text },
    { type: "reasoning", text: "SECRET" },
    { type: "image", data: "SECRET" },
  ],
  overflow: { secret: "SECRET" },
});
describe("activity headline sources", () => {
  it("validates response and three-way display fields", () => {
    expect(Value.Check(ActivityHeadlineResponseSchema, { headline: "" })).toBe(true);
    expect(Value.Check(ActivityHeadlineResponseSchema, { headline: "x", timestamp: "t" })).toBe(
      false,
    );
    for (const headline of [undefined, null, "", "src/a"]) {
      const record = message("a", []);
      expect(
        Value.Check(DisplayRecordSchema, {
          ...projectDisplayRecords([record])[0],
          content: [
            {
              type: "tool_call",
              callId: "c",
              name: "x",
              detailKey: "a:0",
              ...(headline === undefined ? {} : { headline }),
            },
          ],
        }),
      ).toBe(true);
    }
  });
  it("offers canonical steering intent only from bounded public message fields", () => {
    const records = [
      message("steer", [
        call("steer_subagent", {
          agent_id: "agent-1",
          message: "  Keep the test first.\n😀".repeat(1000),
          token: "SECRET",
          transcript: "SECRET",
          verbose: true,
        }),
      ]),
      message("ack", [result("Steering delivered SECRET")], "tool", "steer"),
      message("failed", [result("Delivery failed SECRET")], "tool", "steer"),
    ];
    const before = JSON.stringify(records);
    const source = getActivityHeadlineSource(records, "steer", "steer:0")!;
    expect(source).toMatchObject({ kind: "intent", tool: "steer_subagent" });
    expect(Buffer.byteLength(source.text)).toBeLessThanOrEqual(8192);
    expect(JSON.parse(source.text)).toEqual({
      agent_id: "agent-1",
      message: expect.stringMatching(/^ {2}Keep the test first.\n😀/),
    });
    expect(source.text).not.toContain("SECRET");
    expect(source.text).not.toContain("�");
    const display = projectDisplayRecords(records);
    expect(display[0]).toMatchObject({ content: [{ headline: null }] });
    for (const id of ["ack", "failed"]) {
      expect(getActivityHeadlineSource(records, id, `${id}:0`)).toBeNull();
      const projected = display[records.findIndex((record) => record.id === id)];
      expect(projected?.type === "message" && projected.content[0]).not.toHaveProperty("headline");
    }
    expect(JSON.stringify(records)).toBe(before);
  });
  it("rejects steering aliases and malformed messages, omitting invalid agent IDs", () => {
    for (const value of [undefined, "", " \n\t", 3, [], { token: "SECRET" }]) {
      const record = message("a", [
        call("steer_subagent", value === undefined ? {} : { message: value }),
      ]);
      expect(getActivityHeadlineSource([record], "a", "a:0")).toBeNull();
      const projected = projectDisplayRecords([record])[0];
      expect(projected?.type === "message" && projected.content[0]).not.toHaveProperty("headline");
    }
    for (const name of ["functions.steer_subagent", "mcp__steer_subagent", "steer"]) {
      expect(
        getActivityHeadlineSource(
          [message("a", [call(name, { message: "Continue" })])],
          "a",
          "a:0",
        ),
      ).toBeNull();
    }
    for (const agent_id of [undefined, 3, [], { secret: "SECRET" }]) {
      const record = message("a", [
        call("steer_subagent", {
          message: "Continue",
          ...(agent_id === undefined ? {} : { agent_id }),
        }),
      ]);
      expect(JSON.parse(getActivityHeadlineSource([record], "a", "a:0")!.text)).toEqual({
        message: "Continue",
      });
    }
  });
  it("offers canonical bash intent and causal outcomes without arbitrary arguments", () => {
    const records = [
      message("root", [], "user"),
      message(
        "bash",
        [
          call("bash", {
            command: "😀".repeat(9000),
            timeout: 30,
            token: "SECRET",
            commands: ["SECRET"],
          }),
        ],
        "assistant",
        "root",
      ),
      message("other", [call("read", { path: "private" })], "assistant", "root"),
      message("done", [result("PUBLIC_OUTPUT")], "tool", "bash"),
      message("sibling", [result("SIBLING_SECRET")], "tool", "other"),
      message("repeat", [result("REPEATED_SECRET")], "tool", "done"),
    ];
    const before = JSON.stringify(records);
    const source = getActivityHeadlineSource(records, "bash", "bash:0")!;
    expect(source).toMatchObject({ kind: "intent", tool: "bash" });
    expect(Buffer.byteLength(source.text)).toBeLessThanOrEqual(8192);
    expect(JSON.parse(source.text)).toEqual({ command: expect.stringContaining("😀") });
    expect(source.text).not.toContain("SECRET");
    expect(getActivityHeadlineSource(records, "done", "done:0")).toMatchObject({
      kind: "outcome",
      tool: "bash",
    });
    expect(getActivityHeadlineSource(records, "done", "done:0")!.text).not.toContain("SECRET");
    for (const id of ["sibling", "repeat"])
      expect(getActivityHeadlineSource(records, id, `${id}:0`)).toBeNull();
    const batch = projectDisplayRecords(records);
    expect(batch[1]).toMatchObject({ content: [{ headline: null }] });
    for (const display of batch) expect(Value.Check(DisplayRecordSchema, display)).toBe(true);
    expect(batch[3]).toMatchObject({ content: [{ headline: null }] });
    for (let prefix = 0; prefix <= records.length; prefix++) {
      const project = createDisplayRecordProjector();
      records.slice(0, prefix).forEach(project);
      expect(records.slice(prefix).map(project)).toEqual(batch.slice(prefix));
    }
    expect(JSON.stringify(records)).toBe(before);
    for (const name of ["commands", "functions.bash", "mcp__bash"]) {
      expect(
        getActivityHeadlineSource([message("a", [call(name, { command: "SECRET" })])], "a", "a:0"),
      ).toBeNull();
    }
  });
  it.each(["bash", "codemode"])("rejects empty or malformed %s source arguments", (name) => {
    for (const value of ["", " \n\t", 3, [], { token: "SECRET" }]) {
      const args = { [name === "bash" ? "command" : "code"]: value };
      expect(getActivityHeadlineSource([message("a", [call(name, args)])], "a", "a:0")).toBeNull();
    }
  });
  it("selects only normalized intent fields, quoting and bounding UTF8", () => {
    const records = [
      message("a", [call("codemode", { code: "😀".repeat(9000), token: "SECRET" })]),
    ];
    const before = JSON.stringify(records);
    const source = getActivityHeadlineSource(records, "a", "a:0");
    expect(source).toMatchObject({ kind: "intent", tool: "codemode" });
    expect(Buffer.byteLength(source!.text)).toBeLessThanOrEqual(8192);
    expect(JSON.parse(source!.text).code).toContain("😀");
    expect(source!.text).not.toContain("SECRET");
    expect(JSON.stringify(records)).toBe(before);
    expect(getActivityHeadlineSource(records, "a", "a:00")).toBeNull();
  });
  it("offers intents, outcomes and no unsupported or launch markers", () => {
    for (const name of ["codemode", "subagent", "get_subagent_result", "arbitrary"]) {
      const records = [
        message("a", [call(name, { code: "inspect", prompt: "task", description: "work" })]),
        message("b", [result("Status: running\npartial findings")], "tool", "a"),
      ];
      const projected = projectDisplayRecords(records);
      for (const record of projected) expect(Value.Check(DisplayRecordSchema, record)).toBe(true);
      if (name === "arbitrary") {
        const record = projected[0];
        if (record?.type === "message") expect(record.content[0]).not.toHaveProperty("headline");
      }
      if (name === "codemode" || name === "arbitrary") {
        const record = projected[1];
        if (record?.type === "message") expect(record.content[0]).not.toHaveProperty("headline");
      }
      expect(projected[0]).toMatchObject({
        content: [name !== "arbitrary" ? { headline: null } : { name }],
      });
      expect(getActivityHeadlineSource(records, "b", "b:0")?.kind ?? null).toBe(
        name === "subagent" || name === "get_subagent_result" ? "outcome" : null,
      );
      expect(JSON.stringify(getActivityHeadlineSource(records, "b", "b:0"))).not.toContain(
        "SECRET",
      );
    }
    const launch = [
      message("a", [call("subagent", { prompt: "task" })]),
      message("b", [result("Agent queued in background.\nAgent ID: a")], "tool", "a"),
    ];
    expect(getActivityHeadlineSource(launch, "b", "b:0")).toBeNull();
    expect(projectDisplayRecords(launch)[1]).toMatchObject({ content: [{ isError: true }] });
    expect(JSON.stringify(projectDisplayRecords(launch)[1])).not.toContain("headline");
    expect(
      projectDisplayRecords([message("p", [call("read", { path: "src/a" })])])[0],
    ).toMatchObject({ content: [{ headline: "src/a" }] });
  });
  it("offers bounded canonical result-poll intents with only safe arguments", () => {
    const records = [
      message("a", [
        call("get_subagent_result", {
          agent_id: "😀".repeat(9000),
          wait: true,
          verbose: false,
          token: "SECRET",
          prompt: "SECRET_CHILD",
          timeout: "SECRET",
        }),
      ]),
    ];
    const before = JSON.stringify(records);
    const source = getActivityHeadlineSource(records, "a", "a:0");
    expect(source).toMatchObject({ kind: "intent", tool: "get_subagent_result" });
    expect(Buffer.byteLength(source!.text)).toBeLessThanOrEqual(8192);
    expect(JSON.parse(source!.text)).toEqual({
      agent_id: expect.stringContaining("😀"),
      wait: true,
      verbose: false,
    });
    expect(source!.text).not.toContain("SECRET");
    expect(JSON.stringify(records)).toBe(before);
    expect(projectDisplayRecords(records)[0]).toMatchObject({ content: [{ headline: null }] });
    const malformed = [
      message("b", [
        call("get_subagent_result", {
          agent_id: { private: "SECRET" },
          wait: "SECRET",
          verbose: ["SECRET"],
        }),
      ]),
    ];
    expect(JSON.parse(getActivityHeadlineSource(malformed, "b", "b:0")!.text)).toEqual({
      agent_id: "",
    });
    for (const name of ["mcp__get_subagent_result", "functions.get_subagent_result"]) {
      const other = [message("c", [call(name)])];
      expect(getActivityHeadlineSource(other, "c", "c:0")).toBeNull();
    }
  });
  it("keeps codemode launch acknowledgements ineligible while typed root receipts remain eligible", () => {
    const intent = message("a", [call("codemode", { code: "launch child" })]);
    const acknowledgement = message(
      "b",
      [result("Agent queued in background.\nAgent ID: child")],
      "tool",
      "a",
    );
    expect(getActivityHeadlineSource([intent, acknowledgement], "b", "b:0")).toBeNull();
    expect(projectDisplayRecords([intent, acknowledgement])[1]).toMatchObject({
      content: [{ type: "tool_result" }],
    });
    expect(JSON.stringify(projectDisplayRecords([intent, acknowledgement])[1])).not.toContain(
      "headline",
    );
    const receipt: HistoryRecord = {
      id: "receipt",
      parentId: "b",
      timestamp: "t",
      type: "event",
      eventType: "pi.custom_message",
      overflow: { private: "SECRET" },
      subagent: {
        kind: "notification",
        status: "completed",
        resultPreview: "FOREGROUND_COMPLETION",
      },
    };
    expect(
      getActivityHeadlineSource([intent, acknowledgement, receipt], "receipt", "receipt:subagent"),
    ).toMatchObject({ kind: "outcome", tool: "subagent" });
    expect(projectDisplayRecords([receipt])[0]).toMatchObject({ subagent: { headline: null } });
  });
  it("uses the first canonical wrapper status, not quoted child launch text", () => {
    const a = message("a", [call("subagent", { prompt: "task" })]);
    for (const text of [
      "Agent completed in 2s (1 tool uses).\nAgent ID: a\n\nChild says:\nAgent started in background.",
      "Agent failed: failed\nAgent ID: a\nAgent queued in background.",
    ]) {
      const records = [a, message("b", [result(text)], "tool", "a")];
      expect(getActivityHeadlineSource(records, "b", "b:0")?.kind).toBe("outcome");
      expect(projectDisplayRecords(records)[1]).toMatchObject({ content: [{ headline: null }] });
    }
    for (const status of ["queued", "started"]) {
      const records = [
        a,
        message(
          "b",
          [result(`Locked settings: model ignored\n\nAgent ${status} in background.\nAgent ID: a`)],
          "tool",
          "a",
        ),
      ];
      expect(getActivityHeadlineSource(records, "b", "b:0")).toBeNull();
      expect(JSON.stringify(projectDisplayRecords(records)[1])).not.toContain("headline");
    }
  });
  it("excludes canonical verbose child conversation sections", () => {
    const records = [
      message("a", [call("get_subagent_result")]),
      message(
        "b",
        [result("Status: completed\nUseful result\n\n--- Agent Conversation ---\nSECRET_CHILD")],
        "tool",
        "a",
      ),
    ];
    const source = getActivityHeadlineSource(records, "b", "b:0");
    expect(source?.text).toContain("Useful result");
    expect(source?.text).not.toContain("SECRET_CHILD");
  });
  it("matches once, latest reused IDs, and resets on user and compaction", () => {
    const a = message("a", [call("subagent", { prompt: "task" })]);
    const b = message("b", [result("done")], "tool", "a");
    for (const boundary of [
      message("u", [], "user", "a"),
      {
        id: "x",
        parentId: "a",
        timestamp: "t",
        overflow: {},
        type: "compaction",
        summary: [],
      } as HistoryRecord,
    ]) {
      expect(
        getActivityHeadlineSource([a, boundary, { ...b, parentId: boundary.id }], "b", "b:0"),
      ).toBeNull();
    }
    expect(getActivityHeadlineSource([b, a], "b", "b:0")).toBeNull();
    expect(
      getActivityHeadlineSource(
        [a, message("reuse", [call("unknown")], "assistant", "a"), { ...b, parentId: "reuse" }],
        "b",
        "b:0",
      ),
    ).toBeNull();
    expect(
      getActivityHeadlineSource(
        [a, b, message("second", [result("again")], "tool", "b")],
        "second",
        "second:0",
      ),
    ).toBeNull();
    expect(projectDisplayRecords([a, b])[1]).toMatchObject({
      content: [{ headline: null, isError: true }],
    });
  });
  it("matches only causal ancestors in batch, incremental prefixes and source selection", () => {
    const records = [
      message("root", [], "user"),
      message("read", [call("read", { path: "src/a" })], "assistant", "root"),
      message("agent", [call("subagent")], "assistant", "root"),
      message("read-result", [result("READ_CANARY")], "tool", "read"),
      message("agent-result", [result("AGENT_OUTCOME")], "tool", "agent"),
      message("repeat", [result("CONSUMED")], "tool", "agent-result"),
      message("sibling-result", [result("SIBLING_OUTCOME")], "tool", "agent"),
      message("orphan", [result("UNKNOWN_PARENT")], "tool", "missing"),
      message("new-root", [result("NO_PARENT")], "tool"),
    ];
    const before = JSON.stringify(records);
    const batch = projectDisplayRecords(records);
    for (let prefix = 0; prefix <= records.length; prefix++) {
      const project = createDisplayRecordProjector();
      records.slice(0, prefix).forEach(project);
      expect(records.slice(prefix).map(project)).toEqual(batch.slice(prefix));
    }
    for (const [index, eligible] of [
      [3, false],
      [4, true],
      [5, false],
      [6, true],
      [7, false],
      [8, false],
    ] as const) {
      const record = records[index];
      const display = batch[index];
      if (!record || display?.type !== "message") throw new Error("expected message");
      if (eligible) expect(display.content[0]).toHaveProperty("headline", null);
      else expect(display.content[0]).not.toHaveProperty("headline");
      expect(getActivityHeadlineSource(records, record.id, `${record.id}:0`)?.tool ?? null).toBe(
        eligible ? "subagent" : null,
      );
    }
    expect(
      JSON.stringify(getActivityHeadlineSource(records, "read-result", "read-result:0")),
    ).not.toContain("READ_CANARY");
    expect(JSON.stringify(records)).toBe(before);
  });
  it("keeps resets, duplicate calls, consumption and ignored events branch-local", () => {
    const a = message("a", [call("subagent")]);
    const event: HistoryRecord = {
      id: "event",
      parentId: "a",
      timestamp: "t",
      overflow: {},
      type: "event",
      eventType: "ignored",
      content: [call("read"), result("IGNORED")],
    };
    const records = [
      a,
      message("reset", [], "user", "a"),
      message("duplicate", [call("read"), call("get_subagent_result")], "assistant", "a"),
      event,
      message("event-result", [result("DONE")], "tool", "event"),
      message("reset-result", [result("RESET")], "tool", "reset"),
      message("duplicate-result", [result("LATEST")], "tool", "duplicate"),
      message(
        "same-record",
        [
          result("FIRST"),
          result("SECOND"),
          call("read"),
          call("subagent"),
          result("NEW"),
          result("USED"),
        ],
        "tool",
        "a",
      ),
    ];
    expect(getActivityHeadlineSource(records, "event-result", "event-result:0")?.tool).toBe(
      "subagent",
    );
    expect(getActivityHeadlineSource(records, "reset-result", "reset-result:0")).toBeNull();
    expect(getActivityHeadlineSource(records, "duplicate-result", "duplicate-result:0")?.tool).toBe(
      "get_subagent_result",
    );
    for (const index of [0, 4])
      expect(getActivityHeadlineSource(records, "same-record", `same-record:${index}`)?.tool).toBe(
        "subagent",
      );
    for (const index of [1, 5])
      expect(getActivityHeadlineSource(records, "same-record", `same-record:${index}`)).toBeNull();
    expect(projectDisplayRecords(records).at(-1)).toMatchObject({
      content: [{ headline: null }, {}, {}, { headline: null }, { headline: null }, {}],
    });
  });
  it("preserves receipt failure facts before bounding descriptive text", () => {
    const record: HistoryRecord = {
      id: "r",
      parentId: null,
      timestamp: "t",
      overflow: {},
      type: "event",
      eventType: "pi.custom_message",
      subagent: {
        kind: "notification",
        status: "error",
        description: "x".repeat(10000),
        error: "FAILED_FACT",
        resultPreview: "SECRET",
      },
    };
    const source = getActivityHeadlineSource([record], "r", "r:subagent");
    expect(source?.text).toContain("FAILED_FACT");
    expect(Buffer.byteLength(source!.text)).toBeLessThanOrEqual(8192);
  });
  it("offers typed completion receipts only", () => {
    for (const kind of ["notification", "update", "workspace_notice"] as const) {
      const record: HistoryRecord = {
        id: "r",
        parentId: null,
        timestamp: "t",
        overflow: { secret: "SECRET" },
        type: "event",
        eventType: "pi.custom_message",
        subagent: { kind, status: "error", error: "failed", resultPreview: "SECRET" },
      };
      const source = getActivityHeadlineSource([record], "r", "r:subagent");
      expect(source?.kind ?? null).toBe(kind === "notification" ? "outcome" : null);
      expect(source?.text ?? "").not.toContain("SECRET");
      expect(projectDisplayRecords([record])[0]).toMatchObject({
        subagent: kind === "notification" ? { headline: null, status: "error" } : { kind },
      });
    }
  });
});

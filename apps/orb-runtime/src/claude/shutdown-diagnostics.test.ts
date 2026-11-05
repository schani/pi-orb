import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "vitest";
import { ClaudeShutdownDiagnostics } from "./shutdown-diagnostics.ts";

const sdk = (value: object) => value as SDKMessage;
const initialResult = {
  resultId: "initial",
  subtype: "success",
  isError: false,
  numTurns: 9,
  queuedTurns: 0,
  stopReason: "end_turn",
};
const closeState = {
  outcome: "completed" as const,
  holds: ["root"],
  ownership: { tasks: ["task"] },
};

it("keeps the first close snapshot despite later results, closes and ownership mutation", () => {
  const d = new ClaudeShutdownDiagnostics();
  d.observe(sdk({ type: "result", uuid: "initial", subtype: "success", num_turns: 9 }), false);
  const result = { ...initialResult };
  const state = { ...closeState, ownership: { tasks: ["task"] } };
  d.beginClose("operation_drain", result, state);
  state.ownership.tasks.push("later");
  result.resultId = "mutated";
  d.observe(sdk({ type: "result", uuid: "ack", subtype: "success", num_turns: 0 }), true);
  d.beginClose("external", null, closeState);
  expect(d.snapshot()).toMatchObject({
    initialClose: {
      caller: "operation_drain",
      seq: 2,
      result: { resultId: "initial", numTurns: 9 },
      ownership: { tasks: { count: 1, ids: ["task"], omitted: 0 } },
    },
    edges: [
      { seq: 1, kind: "result", closing: false },
      { seq: 3, kind: "result", closing: true, resultId: "ack", numTurns: 0 },
    ],
  });
});

it("orders late task/tool association, requesting and result edges without SDK content", () => {
  const d = new ClaudeShutdownDiagnostics();
  d.beginClose("operation_drain", null, { ...closeState, ownership: {} });
  for (const message of [
    {
      type: "system",
      subtype: "task_started",
      uuid: "start",
      task_id: "task",
      tool_use_id: "tool",
      task_type: "local_bash",
      description: "PRIVATE_DESCRIPTION",
      prompt: "PRIVATE_PROMPT",
    },
    {
      type: "tool_progress",
      tool_use_id: "tool",
      task_id: "task",
      tool_name: "Bash",
      description: "PRIVATE_COMMAND",
    },
    {
      type: "system",
      subtype: "task_notification",
      uuid: "end",
      task_id: "task",
      tool_use_id: "tool",
      status: "completed",
      summary: "PRIVATE_OUTPUT",
      output_file: "PRIVATE_PATH",
    },
    { type: "system", subtype: "status", status: "requesting" },
    { type: "result", subtype: "success", result: "PRIVATE_RESULT", num_turns: 0 },
  ])
    d.observe(sdk(message), true);
  expect(d.snapshot()).toMatchObject({
    edges: [
      { seq: 2, kind: "task_started", taskId: "task", toolUseId: "tool", taskKind: "local_bash" },
      { seq: 3, kind: "tool_progress", taskId: "task", toolUseId: "tool", toolKind: "Bash" },
      { seq: 4, kind: "task_notification", taskId: "task", status: "completed" },
      { seq: 5, kind: "status", status: "requesting" },
      { seq: 6, kind: "result", numTurns: 0 },
    ],
  });
  expect(JSON.stringify(d.snapshot())).not.toContain("PRIVATE");
});

it("caps entries, UTF-8 bytes, IDs and rosters, reporting loss", () => {
  const d = new ClaudeShutdownDiagnostics();
  const ids = Array.from({ length: 100 }, (_, i) => `id-${i}-${"x".repeat(200)}`);
  d.beginClose("external", null, {
    outcome: "completed",
    holds: [],
    ownership: Object.fromEntries(
      [
        "hooks",
        "children",
        "tasks",
        "inventory",
        "handoffs",
        "ownedChildren",
        "ownedTasks",
        "ownedBackgroundTasks",
        "pendingHandoffs",
      ].map((key) => [key, ids]),
    ),
  });
  for (let i = 0; i < 100; i++) {
    d.observe(
      sdk({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: ids.map((task_id) => ({ task_id, task_type: "local_bash" })),
      }),
      true,
    );
  }
  const snapshot = d.snapshot();
  const encoded = JSON.stringify(snapshot);
  expect(snapshot.edges.length).toBeLessThanOrEqual(48);
  expect(Buffer.byteLength(JSON.stringify(snapshot.edges))).toBeLessThanOrEqual(8192);
  expect(Buffer.byteLength(JSON.stringify(snapshot.initialClose))).toBeLessThanOrEqual(6144);
  expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(16384);
  expect(snapshot.droppedEdges).toBe(100 - snapshot.edges.length);
  expect(snapshot.truncatedFields).toBeGreaterThan(0);
  expect(snapshot.initialClose).toMatchObject({
    ownership: { hooks: { count: 100, omitted: 92 } },
  });
  expect(encoded).not.toContain("x".repeat(65));
});

it("maps unknown enums to other and never copies arbitrary SDK strings or assistant content", () => {
  const d = new ClaudeShutdownDiagnostics();
  for (const message of [
    { type: "system", subtype: "task_started", task_id: "id", task_type: "PRIVATE_KIND" },
    { type: "system", subtype: "task_notification", status: "PRIVATE_STATUS", task_id: "id" },
    { type: "system", subtype: "status", status: "PRIVATE_STATUS" },
    { type: "result", subtype: "PRIVATE_SUBTYPE", stop_reason: "PRIVATE_REASON" },
    {
      type: "assistant",
      parent_tool_use_id: null,
      uuid: "assistant",
      message: {
        content: [
          { type: "text", text: "PRIVATE_TEXT" },
          {
            type: "tool_use",
            id: "tool",
            name: "PRIVATE_TOOL_NAME",
            input: { command: "PRIVATE_ARGUMENTS" },
          },
        ],
      },
    },
    { type: "system", subtype: "informational", content: "PRIVATE_BANNER" },
  ])
    d.observe(sdk(message), false);
  const snapshot = d.snapshot();
  expect(snapshot.edges).toHaveLength(5);
  expect(snapshot.edges.at(-1)).toMatchObject({
    kind: "assistant",
    tools: [{ id: "tool", kind: "other" }],
  });
  expect(JSON.stringify(snapshot)).not.toContain("PRIVATE");
});

it("starts empty for each query", () => {
  const prior = new ClaudeShutdownDiagnostics();
  prior.beginClose("attach", null, closeState);
  prior.observe(sdk({ type: "system", subtype: "status", status: "requesting" }), true);
  expect(new ClaudeShutdownDiagnostics().snapshot()).toMatchObject({
    initialClose: null,
    edges: [],
    droppedEdges: 0,
    truncatedFields: 0,
  });
});

it("validates numeric metadata and identifier syntax before retaining SDK values", () => {
  const d = new ClaudeShutdownDiagnostics();
  d.observe(
    sdk({
      type: "result",
      uuid: "private text",
      session_id: "private/path",
      subtype: "success",
      num_turns: Infinity,
      queued_turn_count: -1,
      stop_reason: { secret: "PRIVATE" },
      is_error: "PRIVATE",
    }),
    false,
  );
  d.observe(
    sdk({ type: "result", num_turns: 1.5, queued_turn_count: Number.MAX_SAFE_INTEGER + 1 }),
    true,
  );
  expect(d.snapshot()).toMatchObject({
    truncatedFields: 3,
    edges: [
      {
        messageId: null,
        nativeSessionId: null,
        resultId: null,
        numTurns: null,
        queuedTurns: null,
        isError: null,
        stopReason: "other",
      },
      { numTurns: null, queuedTurns: null },
    ],
  });
  expect(JSON.stringify(d.snapshot())).not.toMatch(/PRIVATE|private/);
});

it("evicts oldest edges at the entry cap without rewriting sequence numbers", () => {
  const d = new ClaudeShutdownDiagnostics();
  for (let i = 0; i < 100; i++)
    d.observe(sdk({ type: "system", subtype: "status", status: "requesting" }), false);
  const snapshot = d.snapshot();
  expect(snapshot.edges).toHaveLength(48);
  expect(snapshot.droppedEdges).toBe(52);
  expect(snapshot.edges[0]?.seq).toBe(53);
  expect(snapshot.edges.at(-1)?.seq).toBe(100);
});

it("ignores unsafe child content and malformed roster entries without affecting supervision", () => {
  const d = new ClaudeShutdownDiagnostics();
  for (const content of [
    null,
    undefined,
    "PRIVATE_CHILD",
    [null, 1, "PRIVATE_BLOCK", { type: "text", text: "PRIVATE_TEXT" }],
  ]) {
    d.observe(sdk({ type: "assistant", parent_tool_use_id: "parent", message: { content } }), true);
  }
  d.observe(sdk({ type: "assistant", parent_tool_use_id: "parent", message: null }), true);
  d.observe(sdk({ type: "system", subtype: "background_tasks_changed", tasks: null }), true);
  d.observe(
    sdk({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [null, "PRIVATE_TASK", {}, { task_id: "task", task_type: "local_bash" }],
    }),
    true,
  );
  expect(JSON.stringify(d.snapshot())).not.toContain("PRIVATE");
});

it.each([true, false, undefined])(
  "records only tool completion identity and error flag (%s)",
  (is_error) => {
    const d = new ClaudeShutdownDiagnostics();
    d.observe(
      sdk({
        type: "user",
        parent_tool_use_id: null,
        uuid: "user",
        message: {
          content: [
            null,
            "PRIVATE_TEXT",
            { type: "text", text: "PRIVATE_TEXT" },
            { type: "tool_result", tool_use_id: "tool", is_error, content: "PRIVATE_OUTPUT" },
          ],
        },
      }),
      true,
    );
    expect(d.snapshot()).toMatchObject({
      edges: [
        { kind: "tool_result", closing: true, toolUseId: "tool", isError: is_error ?? false },
      ],
    });
    expect(JSON.stringify(d.snapshot())).not.toContain("PRIVATE");
  },
);

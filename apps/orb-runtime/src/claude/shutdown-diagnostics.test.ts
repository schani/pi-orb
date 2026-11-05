import { expect, it } from "vitest";
import { ClaudeShutdownDiagnostics } from "./shutdown-diagnostics.ts";

const result = { resultId: "initial", subtype: "success", numTurns: 9 };
const state = { outcome: "completed" as const, holds: ["root"], ownership: { tasks: ["task"] } };
const requesting = { type: "system", subtype: "status", status: "requesting" };
const closing = () => {
  const d = new ClaudeShutdownDiagnostics();
  d.beginClose("operation_drain", result, state);
  return d;
};
const root = (content: unknown) => ({
  type: "assistant",
  parent_tool_use_id: null,
  message: { content },
});

it("copies first-close inputs, ignores pre-close events and never substitutes later results", () => {
  const d = new ClaudeShutdownDiagnostics();
  d.observe(requesting);
  expect(d.snapshot()).toEqual({
    initialClose: null,
    edges: [],
    droppedEdges: 0,
    truncatedFields: 0,
  });
  const first = { ...result };
  const owners = ["task"];
  d.beginClose("operation_drain", first, { ...state, ownership: { tasks: owners } });
  first.resultId = "mutated";
  owners.push("later");
  d.observe({ type: "result", uuid: "ack", num_turns: 0 });
  d.beginClose("external", null, state);
  expect(d.snapshot()).toMatchObject({
    initialClose: {
      seq: 1,
      caller: "operation_drain",
      result,
      ownership: { tasks: { count: 1, ids: ["task"], omitted: 0 } },
    },
    edges: [{ seq: 2, kind: "result", resultId: "ack", numTurns: 0 }],
  });
});

it.each(["assistant", "result", "task_started", "task_notification", "user", "status"])(
  "excludes content from %s",
  (family) => {
    const d = closing();
    d.observe({
      ...root([
        { type: "tool_use", id: "tool", name: "Bash", input: { command: "PRIVATE" } },
        { type: "tool_result", tool_use_id: "tool", content: "PRIVATE" },
      ]),
      type: ["assistant", "result", "user"].includes(family) ? family : "system",
      subtype: family,
      status: family === "status" ? "requesting" : "completed",
      description: "PRIVATE",
      prompt: "PRIVATE",
      summary: "PRIVATE",
      result: "PRIVATE",
    });
    expect(d.snapshot().edges).toHaveLength(1);
    expect(JSON.stringify(d.snapshot())).not.toContain("PRIVATE");
  },
);

it.each([true, false, undefined, "PRIVATE"])("validates tool-result flags: %s", (is_error) => {
  const d = closing();
  const block = { type: "tool_result", tool_use_id: "tool", is_error, content: "PRIVATE" };
  d.observe({ type: "user", message: { content: [block] } });
  expect(d.snapshot().edges[0]?.isError).toBe(
    is_error === undefined ? false : typeof is_error === "boolean" ? is_error : null,
  );
  expect(JSON.stringify(d.snapshot())).not.toContain("PRIVATE");
});

it("ignores excluded families and guards malformed messages/content", () => {
  const d = closing();
  for (const message of [
    null,
    [],
    "PRIVATE",
    { ...root(null), parent_tool_use_id: "child" },
    {
      type: "user",
      parent_tool_use_id: "child",
      message: {
        content: [{ type: "tool_result", tool_use_id: "child-tool", content: "PRIVATE" }],
      },
    },
    { type: "tool_progress" },
    ...["hook_started", "hook_response", "task_progress", "background_tasks_changed", "status"].map(
      (subtype) => ({ type: "system", subtype }),
    ),
  ])
    d.observe(message);
  expect(d.snapshot().edges).toEqual([]);
  for (const content of [null, "PRIVATE", [null, 1, "PRIVATE"]]) {
    d.observe(root(content));
    d.observe({ type: "user", message: { content } });
  }
  expect(d.snapshot().edges).toMatchObject(
    Array(3).fill({ kind: "assistant", tools: [], toolsCount: 0 }),
  );
  expect(JSON.stringify(d.snapshot())).not.toContain("PRIVATE");
  d.observe({
    type: "system",
    subtype: "task_started",
    task_id: 7,
    task_type: "PRIVATE",
    ambient: "PRIVATE",
  });
  d.observe(root([{ type: "tool_use", id: "bad id", name: "PRIVATE" }]));
  expect(d.snapshot().edges.slice(-2)).toMatchObject([
    { taskId: null, taskKind: "other", ambient: null },
    { tools: [{ id: null, kind: "other" }] },
  ]);
});

it.each([-1, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, "PRIVATE"])(
  "validates numeric metadata and enum/identifier primitives: %s",
  (value) => {
    const d = closing();
    d.observe({
      type: "result",
      uuid: "private/path",
      subtype: "PRIVATE",
      num_turns: value,
      queued_turn_count: value,
      stop_reason: {},
      is_error: "PRIVATE",
    });
    expect(d.snapshot()).toMatchObject({
      truncatedFields: 2,
      edges: [
        {
          resultId: null,
          subtype: "other",
          stopReason: "other",
          isError: null,
          numTurns: null,
          queuedTurns: null,
        },
      ],
    });
    expect(JSON.stringify(d.snapshot())).not.toMatch(/PRIVATE|private/);
  },
);

it("bounds first close below 4 KiB and the entire diagnostic at 8 KiB/32 edges", () => {
  const d = new ClaudeShutdownDiagnostics();
  const ids = Array(100).fill("x".repeat(200));
  const groups =
    "hooks children tasks inventory handoffs ownedChildren ownedTasks ownedBackgroundTasks pendingHandoffs".split(
      " ",
    );
  const owners = ids.slice(0, 4);
  owners.length = 2 ** 32 - 1;
  d.beginClose(
    "initialization_failure",
    {
      resultId: ids[0],
      numTurns: Number.MAX_SAFE_INTEGER,
      queuedTurns: Number.MAX_SAFE_INTEGER,
      subtype: "error_max_structured_output_retries",
      stopReason: "stop_sequence",
      isError: false,
    },
    {
      outcome: "completed",
      holds: Array(100).fill("root").concat(groups),
      ownership: Object.fromEntries(groups.map((group) => [group, owners])),
    },
  );
  const before = JSON.stringify(d.snapshot().initialClose);
  expect(Buffer.byteLength(before)).toBeLessThan(4096);
  for (const group of groups)
    expect(d.snapshot().initialClose).toMatchObject({
      ownership: {
        [group]: {
          count: owners.length,
          ids: Array(4).fill("x".repeat(64)),
          omitted: owners.length - 4,
        },
      },
    });
  for (let i = 0; i < 100; i++)
    d.observe({ ...root(ids.map((id) => ({ type: "tool_use", id }))), uuid: ids[0] });
  const snapshot = d.snapshot();
  expect(snapshot.edges.length).toBeGreaterThan(0);
  expect(snapshot.edges.length).toBeLessThanOrEqual(32);
  expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(8192);
  expect(snapshot.droppedEdges).toBe(100 - snapshot.edges.length);
  expect(snapshot.edges[0]?.seq).toBe(102 - snapshot.edges.length);
  expect(snapshot.edges.at(-1)).toMatchObject({ seq: 101, toolsCount: 100, toolsOmitted: 96 });
  expect(JSON.stringify(snapshot.initialClose)).toBe(before);
  expect(JSON.stringify(snapshot)).not.toContain("x".repeat(65));
  expect(snapshot.truncatedFields).toBe(1 + 36 + 500);
  const small = closing();
  for (let i = 0; i < 100; i++) small.observe(requesting);
  expect(small.snapshot().edges).toHaveLength(32);
  expect(small.snapshot()).toMatchObject({ droppedEdges: 68 });
  expect(small.snapshot().edges[0]?.seq).toBe(70);
});

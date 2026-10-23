import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { HistorySearchRequestSchema, OrbSpawnRequestSchema } from "@pi-orb/protocol";
import { errAsync, okAsync } from "neverthrow";
import { Check } from "typebox/value";
import { assert, expect, it, vi } from "vitest";
import type { OrbAgentOperations } from "../../../domain/orb-agent-operations.ts";
import { createOrbTools } from "./orb-tools.ts";

it.each([{ provider: "claude", id: "opus" }])("forwards model intent %j", async (model) => {
  const invoke = vi.fn<OrbAgentOperations["invoke"]>(() => okAsync({ accepted: true }));
  const tool = createOrbTools({ invoke }).find((t) => t.name === "orb_spawn")!;
  expect(tool.description).toBe(
    "Create a same-project orb with a prompt. Orbs do not share workspaces.",
  );
  expect(tool.parameters).toBe(OrbSpawnRequestSchema);
  await tool.execute(
    { prompt: "work", model },
    { taskId: 42, callId: "call" } as ToolExecutionApi,
    BACKGROUND_CONTEXT,
  );
  expect(invoke).toHaveBeenCalledWith({ kind: "spawn", prompt: "work", model }, '[42,"call"]');
});

it("uses the shared search schema and forwards default scope unchanged", async () => {
  const invoke = vi.fn<OrbAgentOperations["invoke"]>(() => okAsync({ hits: [] }));
  const tool = createOrbTools({ invoke }).find((tool) => tool.name === "orb_search_history");
  assert.isDefined(tool);
  expect(tool.description).toBe(
    "Search your committed public history with BM25. Defaults to this orb; project searches this project and user searches all your orbs. Returns ranked snippets; use orb_transcript for full context.",
  );
  expect(tool.parameters).toBe(HistorySearchRequestSchema);
  expect(Check(tool.parameters, { query: "marker", limit: 1.5 })).toBe(false);
  expect(Check(tool.parameters, { query: "marker", limit: 51 })).toBe(false);
  expect(tool.replay).toBe("safe");
  await tool.execute(
    { query: "marker" },
    { taskId: 42, callId: "call" } as ToolExecutionApi,
    BACKGROUND_CONTEXT,
  );
  expect(invoke).toHaveBeenCalledExactlyOnceWith(
    { kind: "search", query: "marker" },
    '[42,"call"]',
  );
});

it("distinguishes nested calls while retaining replay identity", async () => {
  const invoke = vi.fn<OrbAgentOperations["invoke"]>(() => okAsync({ accepted: true }));
  const spawn = createOrbTools({ invoke }).find((t) => t.name === "orb_spawn")!;
  for (const callId of ["outer:nested:0", "outer:nested:1", "outer:nested:0"]) {
    await spawn.execute(
      { prompt: "child" },
      { taskId: 42, callId } as ToolExecutionApi,
      BACKGROUND_CONTEXT,
    );
  }
  const ids = invoke.mock.calls.map((call) => call[1]);
  expect(ids[0]).not.toBe(ids[1]);
  expect(ids[0]).toBe(ids[2]);
});

it("uses durable child task identities and does not expose authority arguments", async () => {
  const invoke = vi.fn(() => okAsync({ accepted: true }));
  const tools = createOrbTools({ invoke });
  expect(tools.map((t) => t.name)).toEqual([
    "orb_self",
    "orb_list",
    "orb_transcript",
    "orb_search_history",
    "orb_spawn",
    "orb_send",
    "orb_alert",
    "notify_parent",
    "orb_sleep",
    "orb_archive",
    "orb_delete",
  ]);
  const sleep = tools.find((t) => t.name === "orb_sleep")!;
  await sleep.execute(
    { durationSeconds: 60 },
    { taskId: 42, callId: "call" } as ToolExecutionApi,
    BACKGROUND_CONTEXT,
  );
  expect(invoke).toHaveBeenCalledWith({ kind: "sleep", durationSeconds: 60 }, '[42,"call"]');
  for (const tool of tools) {
    expect(tool.parameters).toHaveProperty("additionalProperties", false);
    expect(JSON.stringify(tool.parameters)).not.toMatch(/ownerUserId|incarnation|runtimeTokenHash/);
  }
  expect(tools.find((t) => t.name === "orb_delete")!.replay).toBe("unsafe");
  expect(tools.find((t) => t.name === "orb_alert")!.replay).toBe("unsafe");
});

it.each(["denied", "unbound"] as const)(
  "fails closed for %s child notification",
  async (binding) => {
    const invoke = vi.fn<OrbAgentOperations["invoke"]>(() => okAsync({ accepted: true }));
    const notify = vi.fn(() => errAsync({ code: "unauthorized" as const, message: "revoked" }));
    const alert = createOrbTools({ invoke }, binding === "denied" ? notify : undefined).find(
      (tool) => tool.name === "notify_parent",
    );
    assert.isDefined(alert);
    const result = await alert.execute(
      { message: "PRIVATE" },
      { taskId: 42, conversationId: 7, callId: "outer:nested:0" } as ToolExecutionApi,
      BACKGROUND_CONTEXT,
    );
    expect(result.isError).toBe(true);
    if (binding === "denied") {
      expect(JSON.stringify(result.output)).toContain("unauthorized");
      expect(invoke).toHaveBeenCalledExactlyOnceWith(
        { kind: "notification_admission" },
        '[42,"outer:nested:0"]',
      );
    } else expect(invoke).not.toHaveBeenCalled();
  },
);

it("describes family inspection and alerts without parent delivery", () => {
  const tools = createOrbTools({ invoke: () => okAsync({}) });
  expect(tools.find((tool) => tool.name === "orb_self")?.description).toMatch(/parent.*child/i);
  expect(tools.find((tool) => tool.name === "orb_alert")?.description).toContain("Notify the user");
});

it("binds peer sends to durable tool call identity, never model sender input", async () => {
  const invoke = vi.fn(() => okAsync({ orbId: "target", messageId: "receipt" }));
  const tool = createOrbTools({ invoke }).find((t) => t.name === "orb_send");
  expect(tool).toBeDefined();
  if (!tool) return;
  expect(tool.replay).toBe("safe");
  expect(tool.description).toBe(
    "Send a message to another orb and wake it. Orbs do not share file systems! Acceptance is not a reply.",
  );
  await tool.execute(
    { orbId: "target", message: "hi" },
    { taskId: "task", callId: "call" } as never,
    BACKGROUND_CONTEXT,
  );
  expect(invoke).toHaveBeenCalledWith(
    { kind: "send", orbId: "target", message: "hi" },
    JSON.stringify(["task", "call"]),
  );
});

it("returns structured values alongside readable model output", async () => {
  const tool = createOrbTools({ invoke: () => okAsync({ accepted: true }) })[0];
  assert.isDefined(tool);
  const result = await tool.execute(
    {},
    { taskId: 42, callId: "call" } as ToolExecutionApi,
    BACKGROUND_CONTEXT,
  );
  expect(result).toEqual({
    structuredOutput: { accepted: true },
    output: [{ type: "text", text: '{"accepted":true}' }],
  });
});

it("notifies only the parent from a child, retaining admission and call identity", async () => {
  const invoke = vi.fn<OrbAgentOperations["invoke"]>(() => okAsync({ accepted: true }));
  const notify = vi.fn(() => okAsync({ accepted: true as const }));
  const tool = createOrbTools({ invoke }, notify).find((tool) => tool.name === "notify_parent")!;
  expect(tool.replay).toBe("unsafe");
  const api = { taskId: 42, conversationId: 7, callId: "outer:nested:0" } as ToolExecutionApi;
  expect(await tool.execute({ message: "report" }, api, BACKGROUND_CONTEXT)).toEqual({
    structuredOutput: { accepted: true },
    output: [{ type: "text", text: '{"accepted":true}' }],
  });
  expect(invoke).toHaveBeenCalledExactlyOnceWith(
    { kind: "notification_admission" },
    '[42,"outer:nested:0"]',
  );
  expect(notify).toHaveBeenCalledExactlyOnceWith("report", api, BACKGROUND_CONTEXT);
});

it("does not notify when application admission is rejected", async () => {
  const invoke = vi.fn<OrbAgentOperations["invoke"]>(() =>
    errAsync({ code: "unauthorized", message: "stopped" }),
  );
  const notify = vi.fn(() => okAsync({ accepted: true as const }));
  const tool = createOrbTools({ invoke }, notify).find((tool) => tool.name === "notify_parent")!;
  const result = await tool.execute(
    { message: "report" },
    { taskId: 42, conversationId: 7, callId: "call" } as ToolExecutionApi,
    BACKGROUND_CONTEXT,
  );
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.output)).toContain("stopped");
  expect(notify).not.toHaveBeenCalled();
});

it.each([
  { name: "orb_alert", conversationId: 7 },
  { name: "notify_parent", conversationId: ROOT_CONVERSATION_ID },
])("rejects $name in the wrong conversation before effects", async ({ name, conversationId }) => {
  const invoke = vi.fn<OrbAgentOperations["invoke"]>(() => okAsync({ accepted: true }));
  const notify = vi.fn(() => okAsync({ accepted: true as const }));
  const tool = createOrbTools({ invoke }, notify).find((tool) => tool.name === name)!;
  const result = await tool.execute(
    { message: "report" },
    { taskId: 42, conversationId, callId: "call" } as ToolExecutionApi,
    BACKGROUND_CONTEXT,
  );
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.output)).toContain("unauthorized");
  expect(invoke).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
});

it("alerts only the user from the root", async () => {
  const invoke = vi.fn<OrbAgentOperations["invoke"]>(() => okAsync({ accepted: true }));
  const notify = vi.fn(() => okAsync({ accepted: true as const }));
  const tool = createOrbTools({ invoke }, notify).find((tool) => tool.name === "orb_alert")!;
  await tool.execute(
    { message: "report" },
    { taskId: 42, conversationId: ROOT_CONVERSATION_ID, callId: "call" } as ToolExecutionApi,
    BACKGROUND_CONTEXT,
  );
  expect(invoke).toHaveBeenCalledExactlyOnceWith(
    { kind: "alert", message: "report" },
    '[42,"call"]',
  );
  expect(notify).not.toHaveBeenCalled();
});

const project = { id: "project", name: "Project", repositoryUrl: null };
const item = { id: "orb", name: null, state: "running", updatedAt: "now", project };
const responses = [
  [
    "orb_self",
    {},
    {
      orb: { id: "orb", name: null, url: "url", createdAt: "now" },
      project,
      spawnedByOrb: null,
      children: [],
      previewHost: null,
    },
  ],
  ["orb_list", {}, { currentOrbId: "orb", items: [item] }],
  [
    "orb_transcript",
    { orbId: "orb" },
    { orb: item, session: null, cursor: null, headId: null, records: [] },
  ],
  [
    "orb_spawn",
    { prompt: "work" },
    { orbId: "orb", projectId: "project", messageId: "message", url: "url" },
  ],
  [
    "orb_search_history",
    { query: "marker" },
    {
      hits: [
        {
          orbId: "orb",
          sessionId: "session",
          recordId: "record",
          name: null,
          projectName: "Project",
          snippet: "marker",
          score: 1,
          orbUrl: "url",
        },
      ],
    },
  ],
  ["orb_send", { orbId: "orb", message: "hi" }, { orbId: "orb", messageId: "message" }],
  ["orb_alert", { message: "hi" }, { recordId: "record", duplicate: false }],
  ["notify_parent", { message: "hi" }, { accepted: true }],
  ["orb_sleep", { durationSeconds: 60 }, { sleepId: "sleep", sleepUntil: 123456 }],
  ["orb_archive", {}, { orbId: "orb", state: "archived" }],
  ["orb_delete", {}, { orbId: "orb", state: "deleting" }],
] as const;

it.each(responses)(
  "%s returns schema-checked success and typed errors",
  async (name, args, value) => {
    const api = {
      taskId: 42,
      callId: "call",
      conversationId: name === "notify_parent" ? 7 : ROOT_CONVERSATION_ID,
    } as ToolExecutionApi;
    const error = { code: "unavailable" as const, message: "operation unavailable" };
    for (const failed of [false, true]) {
      const invoke: OrbAgentOperations["invoke"] = () =>
        failed ? errAsync(error) : okAsync(value);
      const tool = createOrbTools({ invoke }, () => okAsync({ accepted: true as const })).find(
        (tool) => tool.name === name,
      );
      assert.isDefined(tool);
      const result = await tool.execute(args as never, api, BACKGROUND_CONTEXT);
      const expected = failed ? { error } : value;
      expect(result.structuredOutput).toEqual(expected);
      expect(result.output).toEqual([{ type: "text", text: JSON.stringify(expected) }]);
      expect(result.isError === true).toBe(failed);
      assert.isDefined(tool.structuredOutputSchema);
      expect(Check(tool.structuredOutputSchema, expected)).toBe(true);
      expect(Check(tool.structuredOutputSchema, JSON.stringify(expected))).toBe(false);
      expect(Check(tool.structuredOutputSchema, { error: { code: "bogus", message: "bad" } })).toBe(
        false,
      );
      if (failed) expect(result.diagnostics).toContainEqual({ severity: "error", ...error });
    }
  },
);

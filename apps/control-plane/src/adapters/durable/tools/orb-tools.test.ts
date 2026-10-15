import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { OrbSpawnRequestSchema } from "@pi-orb/protocol";
import { errAsync, okAsync } from "neverthrow";
import { assert, expect, it, vi } from "vitest";
import type { OrbAgentOperations } from "../../../domain/orb-agent-operations.ts";
import { createOrbTools } from "./orb-tools.ts";

it.each([{ provider: "claude", id: "opus" }])("forwards model intent %j", async (model) => {
  const invoke = vi.fn<OrbAgentOperations["invoke"]>(() => okAsync({ accepted: true }));
  const tool = createOrbTools({ invoke }).find((t) => t.name === "orb_spawn")!;
  expect(tool.parameters).toBe(OrbSpawnRequestSchema);
  await tool.execute(
    { prompt: "work", model },
    { taskId: 42, callId: "call" } as ToolExecutionApi,
    BACKGROUND_CONTEXT,
  );
  expect(invoke).toHaveBeenCalledWith({ kind: "spawn", prompt: "work", model }, '[42,"call"]');
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
    "orb_spawn",
    "orb_send",
    "orb_alert",
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
      (tool) => tool.name === "orb_alert",
    );
    assert.isDefined(alert);
    const result = await alert.execute(
      { message: "PRIVATE" },
      { taskId: 42, conversationId: 7, callId: "outer:nested:0" } as ToolExecutionApi,
      BACKGROUND_CONTEXT,
    );
    expect(result.isError).toBe(true);
    if (binding === "denied") {
      expect(JSON.stringify(result.content)).toContain("unauthorized");
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
  expect(tools.find((tool) => tool.name === "orb_alert")?.description).toContain(
    "Alerts are not sent to the parent orb.",
  );
});

it("binds peer sends to durable tool call identity, never model sender input", async () => {
  const invoke = vi.fn(() => okAsync({ orbId: "target", messageId: "receipt" }));
  const tool = createOrbTools({ invoke }).find((t) => t.name === "orb_send");
  expect(tool).toBeDefined();
  if (!tool) return;
  expect(tool.replay).toBe("safe");
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

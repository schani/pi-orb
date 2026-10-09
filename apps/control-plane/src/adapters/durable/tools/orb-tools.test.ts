import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { okAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import type { OrbAgentOperations } from "../../../domain/orb-agent-operations.ts";
import { createOrbTools } from "./orb-tools.ts";

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

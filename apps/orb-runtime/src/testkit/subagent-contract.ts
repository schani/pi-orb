import assert from "node:assert/strict";
import type { PiOrbAgent } from "../pi/agent.ts";

/** Same ownership oracle for simulated SDK events and installed-package runs. */
export function assertSubagentActivity(
  agent: Pick<PiOrbAgent, "getHealth" | "snapshot" | "gateView" | "liveView">,
  activity: "busy" | "idle",
  operationId: string | null,
): void {
  const health = agent.getHealth();
  assert.ok(health.status === "ready");
  assert.equal(health.activity, activity);
  assert.equal(health.operationId ?? null, operationId);
  assert.equal(agent.snapshot()._unsafeUnwrap().activity, activity);
  assert.equal(agent.gateView().activity, activity);
  assert.equal(agent.gateView().activeOperationId, operationId);
  assert.equal(agent.liveView()?.operationId ?? null, operationId);
}

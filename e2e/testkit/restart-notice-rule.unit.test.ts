import { expect, it } from "vitest";
import { planBootNotification } from "../../apps/orb-runtime/src/pi/boot-notification.ts";
import { restartNoticePattern } from "./restart-notice-rule.ts";

it("matches both runtime-authored settled restart notices used by the ordered full-slice mock", () => {
  const entries = [
    {
      type: "custom",
      customType: "pi-orb.boot",
      data: { runtimeInstanceId: "before", executionId: "host-1", incarnation: "0" },
    },
    { type: "message", id: "user", message: { role: "user", content: "work" } },
    { type: "message", id: "assistant", message: { role: "assistant", stopReason: "stop" } },
  ];
  const rule = new RegExp(restartNoticePattern);
  for (const executionId of ["host-1", "host-2"]) {
    const plan = planBootNotification(entries, entries, {
      runtimeInstanceId: "after",
      executionId,
      incarnation: "0",
    });
    expect(plan.kind).toBe("message");
    if (plan.kind !== "message") continue;
    expect(plan.triggerTurn).toBe(true);
    expect(rule.test(plan.marker.content)).toBe(true);
  }
  expect(rule.test("The host was restarted.")).toBe(false);
  expect(rule.test("The user requested Stop.")).toBe(false);
});

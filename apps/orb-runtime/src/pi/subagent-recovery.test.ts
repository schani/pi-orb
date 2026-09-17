import { expect, it } from "vitest";
import { interruptedSubagents } from "./subagent-recovery.ts";

const admitted = (childId: string, operationId = "op") => ({
  type: "custom",
  customType: "pi-orb.subagent-run",
  data: { childId, operationId, phase: "admitted" },
});
const result = (id: string, status = "completed") => ({
  type: "custom",
  customType: "subagents:record",
  data: { id, status },
});
it("detects child-only interruption without relying on the parent's last turn", () => {
  expect(
    interruptedSubagents([
      admitted("a"),
      admitted("b"),
      result("b"),
      { type: "message", message: { role: "assistant", stopReason: "stop" } },
    ]),
  ).toEqual([{ childId: "a", operationId: "op" }]);
});
it.each(["completed", "error"])(
  "does not replay a persisted %s outcome before host release",
  (status) => {
    expect(interruptedSubagents([admitted("a"), result("a", status)])).toEqual([]);
  },
);
it("retains admissions outside compacted context and does not acknowledge failed notice delivery", () => {
  expect(
    interruptedSubagents([
      admitted("a"),
      { type: "compaction", summary: "root context compacted", firstKeptEntryId: "later" },
      { type: "custom_message", customType: "pi-orb.restart-notification-failed", details: {} },
    ]),
  ).toEqual([{ childId: "a", operationId: "op" }]);
});
it("a late terminal from the previous operation cannot close a resumed execution", () => {
  expect(
    interruptedSubagents([
      admitted("a"),
      result("a"),
      admitted("a", "later"),
      {
        type: "custom",
        customType: "pi-orb.subagent-run",
        data: { childId: "a", operationId: "op", phase: "terminal" },
      },
    ]),
  ).toEqual([{ childId: "a", operationId: "later" }]);
});
it.each(["pi-orb.host-restarted", "pi-orb.sleep-wake"])(
  "tracks the latest resumed run once in %s",
  (customType) => {
    const runs = [admitted("a"), result("a"), admitted("a", "later")];
    const interrupted = interruptedSubagents(runs);
    expect(interrupted).toEqual([{ childId: "a", operationId: "later" }]);
    expect(
      interruptedSubagents([
        ...runs,
        {
          type: "custom_message",
          customType,
          details: { interruptedSubagents: interrupted },
        },
      ]),
    ).toEqual([]);
  },
);

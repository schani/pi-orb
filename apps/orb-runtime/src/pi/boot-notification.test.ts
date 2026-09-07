import { describe, expect, it } from "vitest";
import { type BootIdentity, planBootNotification } from "./boot-notification.ts";

export const boot: BootIdentity = {
  runtimeInstanceId: "runtime-2",
  executionId: "execution-2",
  incarnation: "0",
};
export const initialBoot = {
  type: "custom",
  customType: "pi-orb.boot",
  data: { runtimeInstanceId: "runtime-1", executionId: "execution-1", incarnation: "0" },
};
export const user = { type: "message", id: "u", message: { role: "user", content: "work" } };
export const finished = {
  type: "message",
  id: "a",
  message: { role: "assistant", stopReason: "stop", content: [] },
};
export const dangling = {
  type: "message",
  id: "t",
  message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall" }] },
};
const settled = [initialBoot, user, finished];

function notice(entries: readonly unknown[], identity = boot) {
  const plan = planBootNotification(entries, entries, identity);
  expect(plan.kind).toBe("message");
  if (plan.kind !== "message") throw new Error("expected message");
  return plan;
}

export function persisted(plan: ReturnType<typeof notice>) {
  return { type: "custom_message", id: "notice", ...plan.marker };
}

describe("boot notification decision", () => {
  it("records a silent baseline for a fresh conversation", () => {
    expect(planBootNotification([], [], boot)).toEqual({ kind: "baseline", identity: boot });
  });
  it("wakes a settled conversation immediately with process-loss context", () => {
    const plan = notice(settled);
    expect(plan.triggerTurn).toBe(true);
    expect(plan.marker.customType).toBe("pi-orb.host-restarted");
    expect(plan.marker.content).toContain("All processes running before the restart were killed");
    expect(plan.marker.content).toContain("Do not repeat completed work");
    expect(plan.marker.details).toMatchObject({
      ...boot,
      reason: "host_restarted",
      headRecordId: "a",
    });
  });
  it("recognizes retained compute reboot and replacement independently", () => {
    expect(notice(settled).marker.details.reason).toBe("host_restarted");
    expect(
      notice(settled, { ...boot, executionId: "execution-1", incarnation: "1" }).marker.details
        .reason,
    ).toBe("host_restarted");
  });
  it("never claims all processes died on a runtime-only or unknown restart", () => {
    for (const executionId of ["execution-1", null]) {
      const plan = notice(settled, { ...boot, executionId });
      expect(plan.marker.content).toContain("Other processes may still be running");
      expect(plan.marker.content).not.toContain("All processes");
    }
  });
  it("deduplicates the same runtime boot even after compaction", () => {
    const marker = persisted(notice(settled));
    expect(planBootNotification([...settled, marker], [finished], boot).kind).toBe("none");
  });
  it("combines interrupted-turn resume and restart context in one record", () => {
    const plan = notice([initialBoot, user, dangling]);
    expect(plan.triggerTurn).toBe(true);
    expect(plan.marker.customType).toBe("pi-orb.turn-resume");
    expect(plan.marker.content).toContain("All processes");
    expect(plan.marker.content).toContain("Continue from where you left off");
  });
  it("does not auto-resume a notification that crashed before producing an assistant message", () => {
    const marker = persisted(notice(settled));
    const plan = notice([...settled, marker], { ...boot, runtimeInstanceId: "runtime-3" });
    expect(plan.triggerTurn).toBe(false);
    expect(plan.marker.details.reason).toBe("declined_already_resumed");
    expect(plan.marker.content).toContain("will not be resumed automatically");
  });
  it("compaction cannot erase the notification crash-loop budget", () => {
    const marker = persisted(notice(settled));
    const compacted = {
      type: "compaction",
      id: "compact",
      retainedTail: [],
      summary: "earlier work",
    };
    const plan = planBootNotification([...settled, marker, dangling, compacted], [compacted], {
      ...boot,
      runtimeInstanceId: "runtime-3",
    });
    expect(plan.kind === "message" && plan.triggerTurn).toBe(false);
  });
  it("does not grant a notification-generated tool turn an extra retry", () => {
    const marker = persisted(notice(settled));
    const plan = notice([...settled, marker, dangling], {
      ...boot,
      runtimeInstanceId: "runtime-3",
    });
    expect(plan.triggerTurn).toBe(false);
  });
  it("allows notices on later real restart edges once the notification turn settled", () => {
    const marker = persisted(notice(settled));
    expect(
      notice([...settled, marker, finished], { ...boot, runtimeInstanceId: "runtime-3" })
        .triggerTurn,
    ).toBe(true);
  });
  it("a durable inbox user message resets the loop guard", () => {
    const marker = persisted(notice(settled));
    const inbox = { type: "custom_message", customType: "pi-orb.user-message", id: "inbox" };
    expect(
      notice([...settled, marker, inbox, dangling], { ...boot, runtimeInstanceId: "runtime-3" })
        .triggerTurn,
    ).toBe(true);
  });
  it("delivers context after abort without instructing continuation of aborted work", () => {
    const plan = notice([
      initialBoot,
      user,
      { ...finished, message: { role: "assistant", stopReason: "aborted", content: [] } },
    ]);
    expect(plan.marker.customType).toBe("pi-orb.host-restarted");
    expect(plan.marker.content).toContain("Do not resume aborted work");
    expect(plan.marker.content).not.toContain("Continue from where you left off");
  });
});

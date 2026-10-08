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
    expect(plan.marker.content).toBe(
      "The host was restarted involuntarily. Continue whatever you were doing, but note: All processes running before the restart were killed, including servers, background jobs, and shell sessions. Reassess any assumptions about running processes; restart only what is still needed for the user's task. Do not repeat completed work. Do not resume aborted work.",
    );
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
  it("combines a sleep wake with restart context and inbox identity", () => {
    const plan = planBootNotification(settled, settled, boot, {
      messageId: "sleep-1",
      messageIds: ["sleep-1"],
      content: [{ type: "text", text: "Sleep ended at its scheduled deadline." }],
      system: { kind: "sleep_wake", sleepUntil: "2026-09-18T04:05:06.000Z" },
    });
    expect(plan.kind).toBe("message");
    if (plan.kind !== "message") throw new Error("expected message");
    expect(plan.triggerTurn).toBe(true);
    expect(plan.marker.customType).toBe("pi-orb.sleep-wake");
    expect(plan.marker.content).toContain("All processes running before the restart were killed");
    expect(plan.marker.content).toContain("Sleep ended at its scheduled deadline");
    expect(plan.marker.details).toMatchObject({
      ...boot,
      messageIds: ["sleep-1"],
      sleepUntil: "2026-09-18T04:05:06.000Z",
    });
  });
  it("deduplicates sleep context already persisted before replication", () => {
    const first = planBootNotification(settled, settled, boot, {
      messageId: "sleep-1",
      messageIds: ["sleep-1"],
      content: [{ type: "text", text: "wake" }],
      system: { kind: "sleep_wake", sleepUntil: "2026-09-18T04:05:06.000Z" },
    });
    if (first.kind !== "message") throw new Error("expected message");
    const marker = { type: "custom_message", id: "wake", ...first.marker };
    expect(
      planBootNotification([...settled, marker], [...settled, marker], boot, {
        messageId: "sleep-1",
        messageIds: ["sleep-1"],
        content: [{ type: "text", text: "wake" }],
        system: { kind: "sleep_wake", sleepUntil: "2026-09-18T04:05:06.000Z" },
      }).kind,
    ).toBe("none");
  });
  it("combines interrupted-turn resume and restart context in one record", () => {
    const plan = notice([initialBoot, user, dangling]);
    expect(plan.triggerTurn).toBe(true);
    expect(plan.marker.customType).toBe("pi-orb.turn-resume");
    expect(plan.marker.content).toContain("All processes");
    expect(plan.marker.content).toContain("Continue from where you left off");
    expect(plan.marker.content).not.toContain("Continue whatever you were doing");
  });
  it("claims three attempts even when a notification crashes before inference", () => {
    const marker = persisted(notice(settled));
    const second = notice([...settled, marker], { ...boot, runtimeInstanceId: "runtime-3" });
    expect(second.triggerTurn).toBe(true);
    const third = notice([...settled, marker, persisted(second)], {
      ...boot,
      runtimeInstanceId: "runtime-4",
    });
    expect(third.triggerTurn).toBe(true);
    const plan = notice([...settled, marker, persisted(second), persisted(third)], {
      ...boot,
      runtimeInstanceId: "runtime-5",
    });
    expect(plan.triggerTurn).toBe(false);
    expect(plan.marker.details.reason).toBe("declined_already_resumed");
    expect(plan.marker.content).toContain("will not be resumed automatically");
    expect(plan.marker.content).not.toContain("Continue whatever you were doing");
  });
  it("compaction cannot erase the notification crash-loop budget", () => {
    const marker = persisted(notice(settled));
    const compacted = {
      type: "compaction",
      id: "compact",
      retainedTail: [],
      summary: "earlier work",
    };
    const plan = planBootNotification(
      [...settled, marker, marker, marker, dangling, compacted],
      [compacted],
      {
        ...boot,
        runtimeInstanceId: "runtime-3",
      },
    );
    expect(plan.kind === "message" && plan.triggerTurn).toBe(false);
  });
  it("does not grant a notification-generated tool turn an extra retry", () => {
    const marker = persisted(notice(settled));
    const plan = notice([...settled, marker, marker, marker, dangling], {
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
  it("keeps completed restart notices triggering beyond three claims", () => {
    let records: unknown[] = settled;
    for (const runtimeInstanceId of ["runtime-2", "runtime-3", "runtime-4"]) {
      const plan = notice(records, { ...boot, runtimeInstanceId });
      expect(plan.triggerTurn).toBe(true);
      records = [...records, persisted(plan), finished];
    }
    const fourth = notice(records, { ...boot, runtimeInstanceId: "runtime-5" });
    expect(fourth.triggerTurn).toBe(true);
    expect(fourth.marker.customType).toBe("pi-orb.host-restarted");
    expect(
      notice([...records, user], { ...boot, runtimeInstanceId: "runtime-5" }).triggerTurn,
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
  it("uses the exact normal restart notice after a settled aborted tail", () => {
    const plan = notice([
      initialBoot,
      user,
      { ...finished, message: { role: "assistant", stopReason: "aborted", content: [] } },
    ]);
    expect(plan.marker.customType).toBe("pi-orb.host-restarted");
    expect(plan.marker.content).toContain("Do not repeat completed work.");
    expect(plan.marker.content).toContain("Do not resume aborted work.");
    expect(plan.triggerTurn).toBe(true);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  notificationDecision,
  showTurnNotification,
  turnNotificationTitle,
} from "./turn-notifications.ts";

afterEach(() => vi.unstubAllGlobals());

describe("turn notifications", () => {
  it("prefers the orb's display name and falls back to its id", () => {
    expect(turnNotificationTitle("orb-123", "Investigate Current Orb Behavior")).toBe(
      "Investigate Current Orb Behavior",
    );
    expect(turnNotificationTitle("orb-123", null)).toBe("Orb orb-123");
    expect(turnNotificationTitle("orb-123", "   ")).toBe("Orb orb-123");
  });

  it.each([
    ["visible", true, { type: "skipped", reason: "foreground" }],
    ["visible", false, null],
    ["hidden", true, null],
    ["hidden", false, null],
  ] as const)("decides for visibility %s and focus %s", (visibility, focused, expected) => {
    expect(notificationDecision("granted", false, visibility === "visible" && focused)).toEqual(
      expected,
    );
  });

  it.each([
    ["visible", true, false],
    ["visible", false, true],
    ["hidden", true, true],
    ["hidden", false, true],
  ] as const)("reads browser visibility %s and focus %s", (visibility, focused, shown) => {
    const notifications = vi.fn();
    const NotificationApi = class {
      static permission = "granted";
      constructor(...args: unknown[]) {
        notifications(...args);
      }
    };
    vi.stubGlobal("window", {
      Notification: NotificationApi,
      focus: vi.fn(),
      location: { hash: "" },
    });
    vi.stubGlobal("document", { visibilityState: visibility, hasFocus: () => focused });
    vi.stubGlobal("Notification", NotificationApi);

    const result = showTurnNotification({
      orbId: "orb-123",
      operationId: `visibility-${visibility}-${focused}`,
      summary: "Done",
    });
    expect(result).toEqual(shown ? { type: "shown" } : { type: "skipped", reason: "foreground" });
    expect(notifications).toHaveBeenCalledTimes(shown ? 1 : 0);
  });

  it("reports unavailable and ungranted notification states", () => {
    expect(notificationDecision("unsupported", false, true)).toEqual({
      type: "skipped",
      reason: "unsupported",
    });
    expect(notificationDecision("default", false, true)).toEqual({
      type: "skipped",
      reason: "permission_default",
    });
    expect(notificationDecision("denied", false, true)).toEqual({
      type: "skipped",
      reason: "permission_denied",
    });
  });

  it("deduplicates an orb operation even in the foreground", () => {
    expect(notificationDecision("granted", true, true)).toEqual({
      type: "skipped",
      reason: "duplicate",
    });
  });
});

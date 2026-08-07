import { describe, expect, it } from "vitest";
import { notificationDecision, turnNotificationTitle } from "./turn-notifications.ts";

describe("turn notifications", () => {
  it("prefers the orb's display name and falls back to its id", () => {
    expect(turnNotificationTitle("orb-123", "Investigate Current Orb Behavior")).toBe(
      "Investigate Current Orb Behavior",
    );
    expect(turnNotificationTitle("orb-123", null)).toBe("Orb orb-123");
    expect(turnNotificationTitle("orb-123", "   ")).toBe("Orb orb-123");
  });

  it("shows granted notifications even while the orb page is foregrounded", () => {
    expect(notificationDecision("granted", false)).toBeNull();
  });

  it("reports unavailable and ungranted notification states", () => {
    expect(notificationDecision("unsupported", false)).toEqual({
      type: "skipped",
      reason: "unsupported",
    });
    expect(notificationDecision("default", false)).toEqual({
      type: "skipped",
      reason: "permission_default",
    });
    expect(notificationDecision("denied", false)).toEqual({
      type: "skipped",
      reason: "permission_denied",
    });
  });

  it("deduplicates an orb operation", () => {
    expect(notificationDecision("granted", true)).toEqual({
      type: "skipped",
      reason: "duplicate",
    });
  });
});

import { describe, expect, it } from "vitest";
import { notificationDecision } from "./turn-notifications.ts";

describe("turn notifications", () => {
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

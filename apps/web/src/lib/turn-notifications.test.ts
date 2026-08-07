import { describe, expect, it } from "vitest";
import { shouldDisplayTurnNotification } from "./turn-notifications.ts";

describe("turn notifications", () => {
  it("shows only granted notifications for background pages", () => {
    expect(
      shouldDisplayTurnNotification({
        permission: "granted",
        visibility: "hidden",
        focused: false,
        alreadyDisplayed: false,
      }),
    ).toBe(true);
    expect(
      shouldDisplayTurnNotification({
        permission: "granted",
        visibility: "visible",
        focused: true,
        alreadyDisplayed: false,
      }),
    ).toBe(false);
    expect(
      shouldDisplayTurnNotification({
        permission: "denied",
        visibility: "hidden",
        focused: false,
        alreadyDisplayed: false,
      }),
    ).toBe(false);
  });

  it("deduplicates an orb operation", () => {
    expect(
      shouldDisplayTurnNotification({
        permission: "granted",
        visibility: "hidden",
        focused: false,
        alreadyDisplayed: true,
      }),
    ).toBe(false);
  });
});

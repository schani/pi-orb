import { describe, expect, it } from "vitest";
import {
  type AlertEntry,
  acceptAlertMetadata,
  beginAlertEntry,
  latestEntryAlertId,
  resolveAlertAck,
  shouldAcknowledgeSelection,
} from "./orb-alert.ts";

describe("alert entry acknowledgement", () => {
  it("captures the ready snapshot, ignoring older cached history when newer metadata is present", () => {
    const record = (id: string) => ({ id, type: "event", alert: { message: id } });
    expect(beginAlertEntry("b", latestEntryAlertId([record("a")], "b")).recordId).toBe("b");
    expect(beginAlertEntry("a", latestEntryAlertId([record("a"), record("b")], "a")).recordId).toBe(
      "b",
    );
    expect(beginAlertEntry(null, latestEntryAlertId([], null)).recordId).toBeNull();
  });
  it("captures the alert observed on entry, never a later poll or live arrival", () => {
    const entry = beginAlertEntry("a", "a");
    expect(entry.recordId).toBe("a");
    expect(entry.recordId).toBe("a");
    expect(resolveAlertAck(entry, "b", null)).toEqual({ unreadAlertId: "b", error: null });
  });

  it("consumes an unflagged entry rather than acknowledging a late alert", () => {
    const entry = beginAlertEntry(null, null);
    expect(entry.recordId).toBeNull();
    expect(entry.recordId).toBeNull();
  });

  it("uses an observed live record when metadata has not replicated yet", () => {
    expect(beginAlertEntry(null, "live").recordId).toBe("live");
  });

  it("keeps the badge and surfaces a failed acknowledgement for retry", () => {
    const entry: AlertEntry = beginAlertEntry("a", null);
    expect(resolveAlertAck(entry, "a", null, "Unavailable")).toEqual({
      unreadAlertId: "a",
      error: "Unavailable",
    });
    expect(beginAlertEntry("a", null).recordId).toBe("a");
  });

  it("only acknowledges foreground selection of the current orb", () => {
    const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
    expect(shouldAcknowledgeSelection("a", "a", click, true)).toBe(true);
    expect(shouldAcknowledgeSelection("a", "b", click, true)).toBe(false);
    expect(shouldAcknowledgeSelection("a", "a", { ...click, ctrlKey: true }, true)).toBe(false);
    expect(shouldAcknowledgeSelection("a", "a", click, false)).toBe(false);
  });

  it("rejects metadata requests started before an acknowledgement, including failed replies", () => {
    expect(acceptAlertMetadata(3, 4)).toBe(false);
    expect(acceptAlertMetadata(4, 4)).toBe(true);
  });

  it("does not erase newer metadata after a stale response", () => {
    const entry = beginAlertEntry("a", null);
    expect(resolveAlertAck(entry, "b", null)).toEqual({ unreadAlertId: "b", error: null });
    expect(resolveAlertAck(entry, "b", "b")).toEqual({ unreadAlertId: "b", error: null });
  });
});

import { describe, expect, it } from "vitest";
import { isSendShortcut } from "./send-shortcut.ts";

describe("isSendShortcut", () => {
  it("accepts cmd-enter and ctrl-enter", () => {
    expect(isSendShortcut({ key: "Enter", metaKey: true, ctrlKey: false })).toBe(true);
    expect(isSendShortcut({ key: "Enter", metaKey: false, ctrlKey: true })).toBe(true);
  });

  it("leaves plain enter for newlines", () => {
    expect(isSendShortcut({ key: "Enter", metaKey: false, ctrlKey: false })).toBe(false);
  });

  it("ignores modified non-enter keys", () => {
    expect(isSendShortcut({ key: "a", metaKey: true, ctrlKey: false })).toBe(false);
  });
});

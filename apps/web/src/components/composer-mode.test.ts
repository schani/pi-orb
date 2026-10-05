import { describe, expect, it } from "vitest";
import { composerModeGlyph, normalizeComposerChange } from "./composer-mode.ts";

describe("composer input", () => {
  it.each(["!", "!!", "!npm test", "!!git status", "say !hello"])(
    "preserves %s literally",
    (text) => {
      expect(normalizeComposerChange("message", text)).toEqual({ mode: "message", text });
      expect(normalizeComposerChange("command", text)).toEqual({ mode: "command", text });
    },
  );

  it("consumes only a leading slash in message mode", () => {
    expect(normalizeComposerChange("message", "/thinking")).toEqual({
      mode: "command",
      text: "thinking",
    });
    expect(normalizeComposerChange("command", "/tmp")).toEqual({ mode: "command", text: "/tmp" });
    expect(normalizeComposerChange("message", "a/b")).toEqual({ mode: "message", text: "a/b" });
    expect(composerModeGlyph("message")).toBe(">");
    expect(composerModeGlyph("command")).toBe("/");
  });
});

import { describe, expect, it } from "vitest";
import {
  composerModeLabel,
  enterShellMode,
  leaveShellMode,
  normalizeComposerChange,
} from "./composer-mode.ts";

describe("composer shell modes", () => {
  it("enters and leaves hidden-prefix modes one bang at a time", () => {
    expect(enterShellMode("message")).toBe("shell");
    expect(enterShellMode("shell")).toBe("excluded_shell");
    expect(enterShellMode("excluded_shell")).toBeNull();
    expect(leaveShellMode("excluded_shell")).toBe("shell");
    expect(leaveShellMode("shell")).toBe("message");
    expect(leaveShellMode("message")).toBeNull();
  });

  it("normalizes pasted prefixes into mode state", () => {
    expect(normalizeComposerChange("message", "!npm test")).toEqual({
      mode: "shell",
      text: "npm test",
    });
    expect(normalizeComposerChange("message", "!!git status")).toEqual({
      mode: "excluded_shell",
      text: "git status",
    });
    expect(normalizeComposerChange("message", "say !hello")).toEqual({
      mode: "message",
      text: "say !hello",
    });
  });

  it("uses the exact visible status labels", () => {
    expect(composerModeLabel("message")).toBe("message");
    expect(composerModeLabel("shell")).toBe("shell");
    expect(composerModeLabel("excluded_shell")).toBe("excluded shell");
  });
});

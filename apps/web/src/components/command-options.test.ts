import { expect, it } from "vitest";
import { commandOptions } from "./command-options.ts";
import { composerModeGlyph, normalizeComposerChange } from "./composer-mode.ts";

const view = {
  type: "agent_settings" as const,
  settings: { model: { provider: "test", id: "a" }, thinkingLevel: "high" as const },
  models: [
    { provider: "test", id: "a", name: "A", thinkingLevels: ["low" as const, "high" as const] },
  ],
  writable: true,
};
it("consumes slash only in message mode, with no shell interpretation", () => {
  expect(normalizeComposerChange("message", "/thinking")).toEqual({
    mode: "command",
    text: "thinking",
  });
  expect(normalizeComposerChange("shell", "/tmp")).toEqual({ mode: "shell", text: "/tmp" });
  expect(normalizeComposerChange("message", "a/b").mode).toBe("message");
  expect(composerModeGlyph("command")).toBe("/");
});
it("offers only supported choices and never converts an unknown command to a prompt", () => {
  expect(commandOptions("", view).map((x) => x.label)).toEqual(["model", "thinking"]);
  expect(commandOptions("thinking ", view).map((x) => x.label)).toEqual(["low", "high"]);
  expect(commandOptions("thinking low", view)[0]?.action).toEqual({
    type: "set_thinking",
    thinkingLevel: "low",
  });
  expect(commandOptions("model A", view)[0]).toMatchObject({
    label: "A",
    action: { type: "set_model", model: { provider: "test", id: "a" } },
  });
  expect(commandOptions("upload", view)).toEqual([]);
});

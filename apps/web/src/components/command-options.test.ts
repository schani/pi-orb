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
it("uses native Claude effort choices without Pi-only levels", () => {
  const claude = {
    ...view,
    models: [
      {
        provider: "test",
        id: "a",
        name: "Claude",
        thinkingLevels: [
          "low" as const,
          "medium" as const,
          "high" as const,
          "xhigh" as const,
          "max" as const,
        ],
      },
    ],
  };
  expect(commandOptions("", claude, "effort").map((option) => option.label)).toEqual([
    "model",
    "effort",
    "compact",
  ]);
  expect(commandOptions("effort ", claude, "effort").map((option) => option.label)).toEqual([
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  expect(commandOptions("effort max", claude, "effort")[0]?.action).toEqual({
    type: "set_thinking",
    thinkingLevel: "max",
  });
  expect(commandOptions("thinking ", claude, "effort")).toEqual([]);
});
it("compact executes directly and accepts optional instructions without settings values", () => {
  expect(commandOptions("comp", null)).toEqual([{ label: "compact", action: { type: "compact" } }]);
  expect(commandOptions("compact", view)[0]?.action).toEqual({ type: "compact" });
  expect(commandOptions("compact  preserve decisions\n and paths  ", view)[0]?.action).toEqual({
    type: "compact",
    customInstructions: "preserve decisions\n and paths",
  });
});
it("consumes slash only in message mode, with no shell interpretation", () => {
  expect(normalizeComposerChange("message", "/thinking")).toEqual({
    mode: "command",
    text: "thinking",
  });
  expect(normalizeComposerChange("command", "/tmp")).toEqual({ mode: "command", text: "/tmp" });
  expect(normalizeComposerChange("message", "a/b").mode).toBe("message");
  expect(composerModeGlyph("command")).toBe("/");
});
it("offers only supported choices and never converts an unknown command to a prompt", () => {
  expect(commandOptions("", view).map((x) => x.label)).toEqual(["model", "thinking", "compact"]);
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

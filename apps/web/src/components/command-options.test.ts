import { expect, it } from "vitest";
import { commandOptions } from "./command-options.ts";

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
it("offers only catalog-backed model choices in offline mode, even with read-only live settings", () => {
  const offlineModels = [{ provider: "test", id: "next", name: "Next model" }];
  const settings = { ...view, writable: false };
  expect(commandOptions("", settings, "thinking", offlineModels)).toEqual([
    { label: "model", text: "model " },
  ]);
  expect(commandOptions("model test/next", settings, "thinking", offlineModels)).toEqual([
    {
      label: "Next model",
      action: { type: "queue_model", model: { provider: "test", id: "next" } },
    },
  ]);
  for (const text of ["model a", "thinking ", "effort ", "compact"]) {
    expect(commandOptions(text, settings, "thinking", offlineModels)).toEqual([]);
  }
});

it("marks only the queued model in the phone picker when it is in the catalog", () => {
  const queued = { provider: "test", id: "next" };
  const models = [
    { ...queued, name: "Next model" },
    { ...queued, provider: "other", name: "Another model" },
  ];
  expect(commandOptions("model ", null, "thinking", models, queued).map((x) => x.label)).toEqual([
    "Next model (queued)",
    "Another model",
  ]);
  expect(
    commandOptions("model another", null, "thinking", models, queued).map((x) => x.label),
  ).toEqual(["Another model"]);
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

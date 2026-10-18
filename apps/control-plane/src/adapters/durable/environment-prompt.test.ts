import { expect, it } from "vitest";
import { piEnvironmentPrompt } from "./environment-prompt.ts";

it("keeps the user-edited Pi suffix empty", () => {
  expect(piEnvironmentPrompt).toBe("");
});

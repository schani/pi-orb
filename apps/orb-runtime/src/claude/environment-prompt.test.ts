import { expect, it } from "vitest";
import { environmentPrompt } from "../environment-prompt.ts";
import { claudeEnvironmentPrompt } from "./environment-prompt.ts";

it("preserves the user-edited Claude CLI suffix without duplicating shared guidance", () => {
  expect(claudeEnvironmentPrompt).toBe(
    "## Orb CLI\n\nThe `pi-orb` CLI allows you to get info on this orb, list/search/read other orbs, create new ones, archive/delete this orb, alert the user, sleep, etc. Use `--help` to get more info.",
  );
  expect(environmentPrompt).not.toContain("## Orb CLI");
});

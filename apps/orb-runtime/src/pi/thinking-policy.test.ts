import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const boot = readFileSync(join(import.meta.dirname, "agent.ts"), "utf8");

describe("agent thinking policy", () => {
  it("sets high after fresh or restored session creation and before binding extensions", () => {
    expect(boot).toMatch(
      /const sdkSession = sessionResult\.value\.session;\s+sdkSession\.setThinkingLevel\("high"\);\s+let binding = true;/,
    );
  });
});

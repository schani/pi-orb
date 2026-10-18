import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("runtime harness boundary", () => {
  it("composes the native Claude agent and its model-usage receiver", () => {
    const source = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
    expect(source).toContain("new ClaudeOrbAgent");
    expect(source).toContain("startModelUsageReceiver");
    expect(source).not.toContain("HARNESS_ENV");
    expect(source).not.toContain("PiOrbAgent");
    expect(source).not.toContain("mockOpenAi");
  });
  it("HTTP depends on the agent port", () => {
    const source = readFileSync(new URL("../http/server.ts", import.meta.url), "utf8");
    expect(source).not.toContain("ClaudeOrbAgent");
    expect(source).toContain("OrbAgent");
  });
});

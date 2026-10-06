import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("runtime harness boundary", () => {
  it("composition selects Claude explicitly and rejects unknown harnesses", () => {
    const source = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
    expect(source).toContain("HARNESS_ENV");
    expect(source).toContain("new ClaudeOrbAgent");
    expect(source).toContain('harness !== "pi" && harness !== "claude"');
  });
  it("HTTP depends on the harness port, not Pi", () => {
    const source = readFileSync(new URL("../http/server.ts", import.meta.url), "utf8");
    expect(source).not.toContain("PiOrbAgent");
    expect(source).toContain("OrbAgent");
  });
});

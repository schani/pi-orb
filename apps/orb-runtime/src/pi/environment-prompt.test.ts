import { describe, expect, it } from "vitest";
import { environmentPrompt } from "./environment-prompt.ts";

describe("runtime environment prompt", () => {
  it("documents Python and the persistent rustup setup", () => {
    expect(environmentPrompt).toContain("Python 3");
    expect(environmentPrompt).toContain("Rust");
    expect(environmentPrompt).toContain("rustup");
    expect(environmentPrompt).toContain("stable is installed by default");
    expect(environmentPrompt).toContain("rust-toolchain.toml");
    expect(environmentPrompt).toContain("persist");
  });

  it("documents the installed browser automation tool", () => {
    expect(environmentPrompt).toContain("agent-browser");
    expect(environmentPrompt).toContain("Chromium");
    expect(environmentPrompt).toContain("agent-browser open <url>");
    expect(environmentPrompt).toContain("agent-browser snapshot");
  });
});

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

  it("documents the boot hooks the repository may own", () => {
    // The failure fragment (`hooks/prompt.ts`) is appended only when a hook
    // broke; an agent that never sees one must still know the convention
    // exists, or it will never write one (docs/orb-setup-hook.md).
    expect(environmentPrompt).toContain(".agents/setup");
    expect(environmentPrompt).toContain(".agents/resume");
    expect(environmentPrompt).toContain("once per compute incarnation");
    expect(environmentPrompt).toContain("every start");
    // The identity split is the rule a hook author gets wrong first.
    expect(environmentPrompt).toContain("without the orb's identity");
    expect(environmentPrompt).toContain("idempotent");
    expect(environmentPrompt).toContain("executable");
    expect(environmentPrompt).toContain("$HOME/.cache/pi-orb/logs");
  });
});

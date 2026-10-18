import { describe, expect, it } from "vitest";
import { claudeEnvironmentPrompt } from "./claude/environment-prompt.ts";
import { environmentPrompt } from "./environment-prompt.ts";

describe("shared runtime environment prompt", () => {
  it("requires an explicit request for progress updates to other orbs", () => {
    const rule = "Do not send progress updates to other orbs unless explicitly asked.";
    expect(environmentPrompt.split(rule)).toHaveLength(2);
    expect(claudeEnvironmentPrompt).not.toContain(rule);
  });

  it("introduces pi-orb before the runtime tools", () => {
    expect(
      environmentPrompt.startsWith(
        "## pi-orb\n\nYou're running on a VM in the cloud via pi-orb: https://github.com/schani/pi-orb\n\n- Python 3",
      ),
    ).toBe(true);
  });

  it("keeps user-interactive process starts out of subagents", () => {
    const guidance = environmentPrompt.indexOf(
      "Do not use subagents to start processes that the user interacts with, because it's too finicky.",
    );
    expect(guidance).toBeGreaterThan(-1);
    expect(guidance).toBeLessThan(environmentPrompt.indexOf("For MCP servers"));
  });

  it("explains browser-owned MCP setup even without configured servers", () => {
    expect(environmentPrompt).toMatch(/MCP servers.*ask.*user.*project.*config gear/i);
    expect(environmentPrompt).toMatch(/MCPs.*OAuth Connect.*Secrets.*static keys/);
    expect(environmentPrompt).toMatch(/catalog changes.*next start/i);
    expect(environmentPrompt).toMatch(/OAuth reauthorization.*no restart/);
    expect(environmentPrompt).not.toContain("pi-orb mcp add");
  });

  it("documents the boot hooks the repository may own", () => {
    // The failure fragment (`hooks/prompt.ts`) is appended only when a hook
    // or its env file breaks; an agent that never sees one must still know the convention
    // exists, or it will never write one (docs/orb-setup-hook.md).
    expect(environmentPrompt).toContain(".agents/setup");
    expect(environmentPrompt).toContain(".agents/resume");
    expect(environmentPrompt).toContain("once per compute incarnation");
    expect(environmentPrompt).toContain("every start");
    // The identity split is the rule a hook author gets wrong first.
    expect(environmentPrompt).toMatch(/executable.*root hooks/i);
    expect(environmentPrompt).toMatch(
      /setup.*once per compute incarnation.*before.*agent.*without.*identity/,
    );
    expect(environmentPrompt).toMatch(/setup.*install toolchains/i);
    expect(environmentPrompt).toMatch(/resume.*every start.*identity.*credentials/i);
    expect(environmentPrompt).toMatch(/both.*idempotent.*\$HOME\/\.cache\/pi-orb\/logs/i);
  });

  it("preserves the exact user-edited runtime bullets", () => {
    expect(environmentPrompt.split("\n").filter((line) => line.startsWith("- "))).toEqual([
      "- Python 3 (`python`, `python3`, virtual environments) and rustup; no default Rust toolchain. Select via `rust-toolchain.toml` or install with rustup. Toolchains/Cargo persist in `$HOME`.",
      "- Chromium and `agent-browser`: `agent-browser open <url>`, then `agent-browser snapshot`; inspect/interact via refs like `@e1`.",
      "- Do not use subagents to start processes that the user interacts with, because it's too finicky.",
      "- Do not send progress updates to other orbs unless explicitly asked.",
      "- For MCP servers, ask the user to open the project's config gear: MCPs (OAuth Connect) or Secrets (static keys). Catalog changes apply next start; OAuth reauthorization needs no restart.",
      "- Executable repo-root hooks: `.agents/setup` runs once per compute incarnation before the agent, without identity; install toolchains there. `.agents/resume` runs every start with identity to authenticate credentials. Both idempotent; logs: `$HOME/.cache/pi-orb/logs`.",
    ]);
  });

  it("keeps harness-specific CLI guidance out of the shared base", () => {
    expect(environmentPrompt).not.toMatch(/`pi-orb /);
    expect(environmentPrompt).not.toContain("## Orb tools");
  });
});

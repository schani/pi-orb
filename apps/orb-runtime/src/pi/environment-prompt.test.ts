import { describe, expect, it } from "vitest";
import { environmentPrompt } from "./environment-prompt.ts";

describe("runtime environment prompt", () => {
  it("introduces pi-orb before the runtime tools", () => {
    expect(
      environmentPrompt.startsWith(
        "## pi-orb\n\nYou're running on a VM in the cloud via pi-orb: https://github.com/schani/pi-orb\n\n## Runtime tools",
      ),
    ).toBe(true);
  });

  it("documents Python and the persistent rustup setup", () => {
    expect(environmentPrompt).toMatch(/Python 3.*python.*python3.*virtual environments/);
    expect(environmentPrompt).toMatch(/rustup.*no (?:default|preinstalled) Rust toolchain/i);
    expect(environmentPrompt).toMatch(/select via.*rust-toolchain\.toml/i);
    expect(environmentPrompt).toMatch(/install with rustup/);
    expect(environmentPrompt).toMatch(/toolchains.*Cargo.*persist.*\$HOME/i);
  });

  it("documents the installed browser automation tool", () => {
    expect(environmentPrompt).toContain("agent-browser");
    expect(environmentPrompt).toContain("Chromium");
    expect(environmentPrompt).toContain("agent-browser open <url>");
    expect(environmentPrompt).toContain("agent-browser snapshot");
    expect(environmentPrompt).toContain("@e1");
    expect(environmentPrompt).toMatch(/inspect.*interact/i);
  });

  it("documents sibling-orb discovery and replicated transcripts", () => {
    expect(environmentPrompt).toContain("pi-orb orbs [query]");
    expect(environmentPrompt).toContain("pi-orb transcript <orb-id>");
    expect(environmentPrompt).toMatch(/transcripts? .*very long/i);
    expect(environmentPrompt).toContain("--json");
    expect(environmentPrompt).toMatch(/--json.*lossless.*structured/);
    expect(environmentPrompt).toMatch(/active.*replicated snapshot.*lag.*live/i);
  });

  it("documents current-orb identity under runtime tools", () => {
    const line =
      "`pi-orb self [--json]` returns this orb’s identity, dashboard URL, project/repository, creation time, and spawning orb.";
    expect(environmentPrompt).toContain(`## Runtime tools\n\n`);
    expect(environmentPrompt).toContain(line);
    expect(environmentPrompt.indexOf(line)).toBeGreaterThan(
      environmentPrompt.indexOf("## Runtime tools"),
    );
  });

  it("distinguishes independent spawned orbs from local subagents", () => {
    expect(environmentPrompt).toContain('pi-orb spawn --prompt "task"');
    expect(environmentPrompt).toMatch(/independent.*same-project.*fresh default-branch checkout/);
    expect(environmentPrompt).toMatch(
      /own conversation.*(?:no shared checkout|doesn't share.*checkout)/,
    );
    expect(environmentPrompt).toMatch(/keeps running.*(?:this orb|parent) stops/);
  });

  it("keeps user-interactive process starts out of subagents", () => {
    const spawn = environmentPrompt.indexOf('pi-orb spawn --prompt "task"');
    const guidance = environmentPrompt.indexOf(
      "Do not use subagents to start processes that the user interacts with, because it's too finicky.",
    );
    expect(guidance).toBeGreaterThan(spawn);
    expect(guidance).toBeLessThan(environmentPrompt.indexOf("For MCP servers"));
  });

  it("requires user intent and preserves the distinct irreversible outcomes", () => {
    expect(environmentPrompt).toMatch(/pi-orb archive.*only.*user asks.*archive this orb/i);
    expect(environmentPrompt).toMatch(/archive.*retain.*conversation.*permanent.*workspace/i);
    expect(environmentPrompt).toMatch(
      /pi-orb delete.*only.*explicit user request.*delete this orb/i,
    );
    expect(environmentPrompt).toMatch(/delete.*permanent.*workspace.*conversation.*hosted files/i);
    expect(environmentPrompt).toMatch(/push\/export.*before archive\/delete/i);
    expect(environmentPrompt).toMatch(/interrupt.*(?:turn|acknowledgement)/i);
  });

  it("explains transcript alerts without requiring explicit permission", () => {
    expect(environmentPrompt).toContain('pi-orb alert "message"');
    expect(environmentPrompt).toMatch(/alert.*transcript.*flags.*orb.*until.*user opens it/i);
    expect(environmentPrompt).not.toMatch(/(?:permission|consent).*alert/i);
  });

  it("documents scheduled self-sleep", () => {
    expect(environmentPrompt).toContain("pi-orb sleep 1h");
    expect(environmentPrompt).toMatch(/absolute wake deadline.*stop.*admitted work/i);
    expect(environmentPrompt).toMatch(/returns.*durably accepted/i);
  });

  it("directs deferred sleep to the CLI rather than process-local waits", () => {
    expect(environmentPrompt).toContain(
      "`pi-orb sleep 1h` sets an absolute wake deadline, stops after admitted work finishes, and returns once durably accepted. To sleep until later, use this command—not code-mode, timers, or shell sleep.",
    );
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
    // broke; an agent that never sees one must still know the convention
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
});

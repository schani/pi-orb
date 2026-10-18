import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ComposedClaudeFixture } from "../testkit/claude-composed.ts";

it("leaves repository instructions to native project discovery", async () => {
  const fixture = new ComposedClaudeFixture();
  try {
    writeFileSync(join(fixture.dir, "AGENTS.md"), "REPOSITORY_AGENTS_MARKER");
    writeFileSync(join(fixture.dir, "CLAUDE.md"), "REPOSITORY_CLAUDE_MARKER");
    expect((await fixture.attach()).isOk()).toBe(true);
    const options = fixture.query.options;
    expect(options.cwd).toBe(fixture.dir);
    expect(options.settingSources).toEqual(["user", "project", "local"]);
    expect(options.tools).toEqual({ type: "preset", preset: "claude_code" });
    expect(options.systemPrompt).toMatchObject({ type: "preset", preset: "claude_code" });
    const system = JSON.stringify(options.systemPrompt);
    expect(system).not.toContain("REPOSITORY_AGENTS_MARKER");
    expect(system).not.toContain("REPOSITORY_CLAUDE_MARKER");
    expect(system).not.toContain("Repository instructions");
    expect(system).not.toContain("Read directory-local AGENTS.md");
  } finally {
    fixture.agent.shutdownHooks();
    fixture.dispose();
  }
});

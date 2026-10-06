import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ClaudeOrbAgent } from "./agent.ts";

it("never advertises ready or falls back to Pi when subscription authentication is absent", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "claude-agent-"));
  try {
    const agent = new ClaudeOrbAgent({
      orbId: "orb",
      repositoryUrl: "https://example.com/repo",
      workDir,
      skillsDir: null,
      broker: null,
    });
    await agent.boot();
    expect(agent.getHealth()).toMatchObject({
      status: "failed",
      error: { code: "claude_auth_required" },
    });
    expect(agent.snapshot().isErr()).toBe(true);
    expect((await agent.submitMessage([{ type: "text", text: "hello" }], "op")).isErr()).toBe(true);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

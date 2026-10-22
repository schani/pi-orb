import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ClaudeOrbAgent } from "./agent.ts";

it.each(["https://example.com/repo", null])(
  "requires subscription authentication with repository %s",
  async (repositoryUrl) => {
    const workDir = mkdtempSync(join(tmpdir(), "claude-agent-"));
    try {
      const agent = new ClaudeOrbAgent({
        orbId: "orb",
        repositoryUrl,
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
      expect((await agent.submitMessage([{ type: "text", text: "hello" }], "op")).isErr()).toBe(
        true,
      );
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  },
);

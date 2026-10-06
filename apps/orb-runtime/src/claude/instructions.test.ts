import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readClaudeRepositoryInstructions } from "./instructions.ts";

it("adds repository AGENTS.md as instructions, without executing its text", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-instructions-"));
  try {
    expect(readClaudeRepositoryInstructions(dir)._unsafeUnwrap()).toBe("");
    writeFileSync(join(dir, "AGENTS.md"), "Use tests first. $(touch unexpected)");
    expect(readClaudeRepositoryInstructions(dir)._unsafeUnwrap()).toContain(
      "Use tests first. $(touch unexpected)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

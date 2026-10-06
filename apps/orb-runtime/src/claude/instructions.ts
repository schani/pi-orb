import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Result } from "neverthrow";

/** Claude discovers CLAUDE.md natively; pi-orb repositories also use AGENTS.md. */
export function readClaudeRepositoryInstructions(cwd: string): Result<string, { message: string }> {
  return Result.fromThrowable(
    () => {
      const path = join(cwd, "AGENTS.md");
      return existsSync(path)
        ? `Repository instructions (${path}):\n${readFileSync(path, "utf8")}\n\nRead directory-local AGENTS.md instructions before editing files there.`
        : "";
    },
    () => ({ message: "Cannot read repository AGENTS.md instructions." }),
  )();
}

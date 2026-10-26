import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OwnerSkillsSnapshot } from "@pi-orb/protocol";
import { Result } from "neverthrow";

/**
 * Owner skills become Claude Code user skills (`<CLAUDE_CONFIG_DIR>/skills/<name>/SKILL.md`),
 * which Claude Code ranks above same-named project skills. The directory is pi-orb's alone:
 * each boot replaces it so skills the owner deleted disappear.
 */
export const materializeOwnerSkills = (
  configDir: string,
  skills: OwnerSkillsSnapshot["skills"],
): Result<void, { message: string }> =>
  Result.fromThrowable(
    () => {
      const root = join(configDir, "skills");
      rmSync(root, { recursive: true, force: true });
      mkdirSync(root, { recursive: true, mode: 0o700 });
      for (const skill of skills) {
        mkdirSync(join(root, skill.name), { mode: 0o700 });
        writeFileSync(join(root, skill.name, "SKILL.md"), skill.content, { mode: 0o600 });
      }
    },
    () => ({ message: "Cannot install owner skills for Claude Code." }),
  )();

import { chmodSync, lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse } from "node:path";
import { type OwnerSkillsSnapshot, validateOwnerSkillsSnapshot } from "@pi-orb/protocol";
import { err, ok, Result } from "neverthrow";

/** Derived, private cache only. Validation completes before any filesystem mutation. */
export function materializeOwnerSkills(
  root: string,
  skills: OwnerSkillsSnapshot["skills"],
): Result<void, { code: "invalid" | "io"; message: string }> {
  const validated = validateOwnerSkillsSnapshot({ skills });
  if (validated.isErr()) return err(validated.error);
  if (!isAbsolute(root) || root === parse(root).root)
    return err({ code: "invalid", message: "Invalid owner skills directory" });
  return Result.fromThrowable(
    () => {
      for (const path of [dirname(root), root]) {
        const info = lstatSync(path, { throwIfNoEntry: false });
        if (info && (!info.isDirectory() || info.isSymbolicLink()))
          return err({
            code: "invalid" as const,
            message: "Owner skills directory has a symlink or non-directory parent",
          });
      }
      mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
      rmSync(root, { recursive: true, force: true });
      mkdirSync(root, { mode: 0o700 });
      for (const skill of skills) {
        const directory = join(root, skill.name);
        mkdirSync(directory, { mode: 0o700 });
        writeFileSync(join(directory, "SKILL.md"), skill.content, { mode: 0o600, flag: "wx" });
        for (const file of skill.files) {
          const target = join(directory, file.path);
          mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
          writeFileSync(target, Buffer.from(file.base64, "base64"), { mode: 0o600, flag: "wx" });
          chmodSync(target, file.executable ? 0o700 : 0o600);
        }
      }
      return ok(undefined);
    },
    (cause) => ({
      code: "io" as const,
      message: `Cannot install owner skills: ${cause instanceof Error ? cause.message : "filesystem write failed"}`,
    }),
  )().andThen((result) => result);
}

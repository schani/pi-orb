import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type OwnerSkillsSnapshot, OwnerSkillsSnapshotSchema } from "@pi-orb/protocol";
import { err, Result } from "neverthrow";
import { Check } from "typebox/value";

export interface OwnerSkillsInstallError {
  type: "owner_skills_install_error";
  backupPath?: string;
  message: string;
}

/** Orb-owned personal skills take precedence over project skills. Import never executes files. */
export function materializeOwnerSkills(
  configDir: string,
  skills: OwnerSkillsSnapshot["skills"],
): Result<void, OwnerSkillsInstallError> {
  const failure = (): OwnerSkillsInstallError => ({
    type: "owner_skills_install_error",
    message: "Cannot install owner skills for Claude Code.",
  });
  if (!Check(OwnerSkillsSnapshotSchema, { skills })) return err(failure());
  const names = new Set<string>();
  let total = 0;
  for (const skill of skills) {
    if (names.has(skill.name)) return err(failure());
    names.add(skill.name);
    const paths = new Set(["SKILL.md"]);
    let size = Buffer.byteLength(skill.content);
    for (const f of skill.files) {
      if (
        paths.has(f.path) ||
        f.path.includes("\\") ||
        f.path.includes("\0") ||
        f.path.split("/").some((p) => !p || p === "." || p === "..") ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(f.base64) ||
        Buffer.from(f.base64, "base64").toString("base64") !== f.base64
      )
        return err(failure());
      paths.add(f.path);
      size += Buffer.from(f.base64, "base64").byteLength;
    }
    for (const path of paths) {
      const parts = path.split("/");
      while (parts.length > 1) {
        parts.pop();
        if (paths.has(parts.join("/"))) return err(failure());
      }
    }
    total += size;
    if (size > 8 * 1024 * 1024) return err(failure());
  }
  if (total > 16 * 1024 * 1024) return err(failure());
  return Result.fromThrowable(() => {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const stage = mkdtempSync(join(configDir, ".skills-"));
    const root = join(configDir, "skills");
    const old = join(stage, "old");
    let retainBackup = false;
    try {
      const next = join(stage, "next");
      mkdirSync(next, { mode: 0o700 });
      for (const skill of skills) {
        const dir = join(next, skill.name);
        mkdirSync(dir, { mode: 0o700 });
        writeFileSync(join(dir, "SKILL.md"), skill.content, { mode: 0o600 });
        for (const f of skill.files) {
          const target = join(dir, f.path);
          mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
          writeFileSync(target, Buffer.from(f.base64, "base64"), {
            mode: f.executable ? 0o700 : 0o600,
          });
          chmodSync(target, f.executable ? 0o700 : 0o600);
        }
      }
      const moved = Result.fromThrowable(
        () => renameSync(root, old),
        (error) => ({
          missing:
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT",
        }),
      )();
      if (moved.isErr() && !moved.error.missing) return err(failure());
      const published = Result.fromThrowable(() => renameSync(next, root), failure)();
      if (published.isErr()) {
        if (moved.isOk()) {
          const restored = Result.fromThrowable(() => renameSync(old, root), failure)();
          if (restored.isErr()) {
            retainBackup = true;
            return err({
              ...failure(),
              backupPath: old,
              message: `Cannot install owner skills for Claude Code. Previous skills retained at ${old}.`,
            });
          }
        }
        return published;
      }
      return published;
    } finally {
      if (!retainBackup) rmSync(stage, { recursive: true, force: true });
    }
  }, failure)().andThen((result) => result);
}

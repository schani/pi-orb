import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { err, ok, Result } from "neverthrow";

export interface RepositoryResources {
  readonly instructions: readonly { path: string; content: string }[];
  readonly skills: readonly string[];
}
const message = (error: unknown): string =>
  `repository resource discovery failed: ${error instanceof Error ? error.message : String(error)}`;
const filesystem = <T>(read: () => T): Result<T, string> => Result.fromThrowable(read, message)();
const present = (path: string): Result<boolean, string> => {
  const info = Result.fromThrowable(
    () => lstatSync(path),
    (error) => error as NodeJS.ErrnoException,
  )();
  return info.isOk()
    ? ok(true)
    : info.error.code === "ENOENT"
      ? ok(false)
      : err(message(info.error));
};

/** Data-only discovery. Aliases may point inside this repository, never outside it. */
export function repositoryResources(cwd: string): Result<RepositoryResources, string> {
  const exists = present(cwd);
  if (exists.isErr()) return err(exists.error);
  if (!exists.value) return ok({ instructions: [], skills: [] });
  const root = filesystem(() => realpathSync(cwd));
  if (root.isErr()) return err(root.error);
  const confined = (path: string): Result<string, string> =>
    filesystem(() => realpathSync(path)).andThen((resolved) => {
      const rel = relative(root.value, resolved);
      return rel === ".." || rel.startsWith("../") || isAbsolute(rel)
        ? err("repository resource escapes checkout")
        : ok(resolved);
    });
  const instructions: { path: string; content: string }[] = [];
  for (const name of [".pi/AGENTS.md", "AGENTS.md", ".agents/AGENTS.md"]) {
    const path = join(cwd, name);
    const found = present(path);
    if (found.isErr()) return err(found.error);
    if (!found.value) continue;
    const contents = confined(path).andThen(() => filesystem(() => readFileSync(path, "utf8")));
    if (contents.isErr()) return err(contents.error);
    instructions.push({ path, content: contents.value });
    break;
  }
  const primary = join(cwd, ".pi", "skills");
  const primaryExists = present(primary);
  if (primaryExists.isErr()) return err(primaryExists.error);
  const selected = primaryExists.value ? primary : join(cwd, ".agents", "skills");
  const skills: string[] = [];
  const seen = new Set<string>();
  const scan = (path: string, depth: number): Result<void, string> => {
    const actual = confined(path);
    if (actual.isErr()) return err(actual.error);
    if (depth > 32) return err("repository skill nesting exceeds limit");
    if (seen.has(actual.value)) return ok(undefined);
    seen.add(actual.value);
    const info = filesystem(() => statSync(path));
    if (info.isErr()) return err(info.error);
    if (!info.value.isDirectory()) return err("repository skills path is not a directory");
    const entries = filesystem(() => readdirSync(path, { withFileTypes: true }));
    if (entries.isErr()) return err(entries.error);
    for (const entry of entries.value) {
      const child = join(path, entry.name);
      const info = confined(child).andThen(() => filesystem(() => statSync(child)));
      if (info.isErr()) return err(info.error);
      if (info.value.isDirectory()) {
        const nested = scan(child, depth + 1);
        if (nested.isErr()) return nested;
      } else if (info.value.isFile() && entry.name === "SKILL.md") skills.push(child);
    }
    return ok(undefined);
  };
  const selectedExists = present(selected);
  if (selectedExists.isErr()) return err(selectedExists.error);
  if (selectedExists.value) {
    const scanned = scan(selected, 0);
    if (scanned.isErr()) return err(scanned.error);
  }
  return ok({ instructions, skills });
}

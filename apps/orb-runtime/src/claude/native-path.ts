import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { err, ok, Result } from "neverthrow";

/** Root filenames carry the native UUID; project-directory escaping/hashing is CLI-owned. */
export function findNativeClaudeTranscript(
  configDir: string,
  sessionId: string,
): Result<string | null, { message: string }> {
  return Result.fromThrowable(
    () => {
      const projects = join(configDir, "projects");
      if (!existsSync(projects)) return [];
      return readdirSync(projects, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(projects, entry.name, `${sessionId}.jsonl`))
        .filter((path) => existsSync(path));
    },
    () => ({ message: "Cannot locate the retained native Claude transcript." }),
  )().andThen((paths) =>
    paths.length > 1
      ? err({ message: "Multiple native roots claim the retained Claude session UUID." })
      : ok(paths[0] ?? null),
  );
}

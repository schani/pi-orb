import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { err, ok, ResultAsync } from "neverthrow";
import type { OwnerSkillError } from "../../domain/owner-skills.ts";
import { type ResourceError, type ResourceFile, resourceError } from "../../domain/resources.ts";
import { snapshotPromptResources } from "../git-resources/prompt.ts";

/** The bundled platform skills shipped with the runtime (`/opt/pi-orb/skills` in orbs). */
export const PLATFORM_SKILLS_ROOT = fileURLToPath(
  new URL("../../../../orb-runtime/skills/", import.meta.url),
);

/** Adapter-only configured application directory, never supplied by model code or host HOME. */
export function loadPlatformResources(root: string): ResultAsync<ResourceFile[], ResourceError> {
  const unavailable = () => resourceError("storage", "Bundled platform resource read failed");
  const run = async () => {
    const files: ResourceFile[] = [];
    let total = 0;
    const scan = async (
      relative: string,
      depth: number,
    ): Promise<import("neverthrow").Result<void, ResourceError>> => {
      if (depth > 16)
        return err(resourceError("limit", "Bundled platform resource depth exceeded"));
      const path = join(root, relative);
      const metadata = await ResultAsync.fromPromise(lstat(path), unavailable);
      if (metadata.isErr()) return err(metadata.error);
      if (metadata.value.isSymbolicLink())
        return err(resourceError("invalid", "Bundled platform resource symlink rejected"));
      if (metadata.value.isDirectory()) {
        const entries = await ResultAsync.fromPromise(readdir(path), unavailable);
        if (entries.isErr()) return err(entries.error);
        for (const name of entries.value.sort()) {
          const result = await scan(relative ? `${relative}/${name}` : name, depth + 1);
          if (result.isErr()) return result;
        }
      } else if (metadata.value.isFile()) {
        if (files.length >= 5000 || total + metadata.value.size > 16 * 1024 * 1024)
          return err(resourceError("limit", "Bundled platform resources exceed limit"));
        const bytes = await ResultAsync.fromPromise(readFile(path), unavailable);
        if (bytes.isErr()) return err(bytes.error);
        total += bytes.value.byteLength;
        if (total > 16 * 1024 * 1024)
          return err(resourceError("limit", "Bundled platform resources exceed limit"));
        files.push({
          path: `/opt/pi-orb/skills/${relative}`,
          bytes: bytes.value,
          sha256: createHash("sha256").update(bytes.value).digest("hex"),
        });
      } else return err(resourceError("invalid", "Unsupported bundled platform resource type"));
      return ok(undefined);
    };
    const scanned = await scan("", 0);
    return scanned.isErr() ? err(scanned.error) : ok(files);
  };
  return ResultAsync.fromSafePromise(run()).andThen((result) => result);
}

/** Skill names Pi loads from the bundled platform skills; owner skills may not take them. */
export function bundledPlatformSkillNames(
  root = PLATFORM_SKILLS_ROOT,
): ResultAsync<ReadonlySet<string>, OwnerSkillError> {
  return loadPlatformResources(root)
    .andThen((files) =>
      snapshotPromptResources({ instructionPath: null, skillRoot: "/opt/pi-orb/skills", files }),
    )
    .map(({ skills }): ReadonlySet<string> => new Set(skills.map((skill) => skill.name)))
    .mapErr(() => ({
      type: "owner_skill_error" as const,
      code: "internal" as const,
      message: "Bundled platform skills unavailable",
    }));
}

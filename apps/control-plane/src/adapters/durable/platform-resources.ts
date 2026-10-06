import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, ResultAsync } from "neverthrow";
import { type ResourceError, type ResourceFile, resourceError } from "../../domain/resources.ts";

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

import { createHash } from "node:crypto";
import { posix } from "node:path";
import { err, ok, Result, ResultAsync } from "neverthrow";
import { type ResourceError, type ResourceFile, resourceError } from "../../domain/resources.ts";
export interface TreeEntry {
  path: string;
  mode: string;
  oid: string;
}
export type BlobReader = (oids: string[]) => ResultAsync<Map<string, Uint8Array>, ResourceError>;
export interface Selection {
  instructionPath: string | null;
  skillRoot: string | null;
  files: ResourceFile[];
}
type Resolution =
  | { phase: "resolved"; entry: TreeEntry }
  | { phase: "absent" }
  | { phase: "pending"; oid: string };
function resolvePath(
  path: string,
  tree: Map<string, TreeEntry>,
  cached: Map<string, Uint8Array>,
): Result<Resolution, ResourceError> {
  const links = new Set<string>();
  let followed = false;
  for (let depth = 0; depth <= 32; depth++) {
    const parts = path.split("/");
    let redirected = false;
    for (let index = 0; index < parts.length; index++) {
      const prefix = parts.slice(0, index + 1).join("/");
      const entry = tree.get(prefix);
      if (!entry)
        return followed
          ? err(resourceError("invalid", "Resource symlink target is missing"))
          : ok({ phase: "absent" });
      if (entry.mode !== "120000") continue;
      if (links.has(prefix)) return err(resourceError("invalid", "Resource symlink cycle"));
      links.add(prefix);
      const bytes = cached.get(entry.oid);
      if (!bytes) return ok({ phase: "pending", oid: entry.oid });
      const decoded = Result.fromThrowable(
        () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        () => resourceError("invalid", "Invalid resource symlink encoding"),
      )();
      if (decoded.isErr()) return err(decoded.error);
      const target = decoded.value;
      if (!target || target.includes("\0") || posix.isAbsolute(target))
        return err(resourceError("invalid", "Resource symlink escapes repository"));
      path = posix.normalize(posix.join(posix.dirname(prefix), target, ...parts.slice(index + 1)));
      if (path === ".." || path.startsWith("../") || path.startsWith("/"))
        return err(resourceError("invalid", "Resource symlink escapes repository"));
      followed = true;
      redirected = true;
      break;
    }
    if (redirected) continue;
    const entry = tree.get(path);
    return entry ? ok({ phase: "resolved", entry }) : ok({ phase: "absent" });
  }
  return err(resourceError("invalid", "Resource symlink depth exceeded"));
}
export function collectResources(
  entries: TreeEntry[],
  blobs: BlobReader,
  limits: { maxBytes?: number; maxPaths?: number } = {},
): ResultAsync<Selection, ResourceError> {
  const run = async () => {
    const tree = new Map<string, TreeEntry>();
    const children = new Map<string, TreeEntry[]>();
    for (const entry of entries) {
      tree.set(entry.path, entry);
      const parent = posix.dirname(entry.path);
      const siblings = children.get(parent) ?? [];
      siblings.push(entry);
      children.set(parent, siblings);
    }
    const cached = new Map<string, Uint8Array>();
    const fetch = async (oids: Set<string>) => {
      const result = await blobs([...oids]);
      if (result.isErr()) return err(result.error);
      for (const oid of oids) {
        const bytes = result.value.get(oid);
        if (!bytes) return err(resourceError("fetch", "Required resource blob unavailable"));
        cached.set(oid, bytes);
      }
      return [...cached.values()].reduce((sum, b) => sum + b.byteLength, 0) >
        (limits.maxBytes ?? 32 * 1024 * 1024)
        ? err(resourceError("limit", "Resource byte limit exceeded"))
        : ok(undefined);
    };
    const groups = [
      [".pi/AGENTS.md", "AGENTS.md", ".agents/AGENTS.md"],
      [".pi/skills", ".agents/skills"],
    ];
    const indices = [0, 0];
    const roots: Array<{ alias: string; entry: TreeEntry } | null> = [null, null];
    const queue: Array<{
      alias: string;
      path: string;
      seen: string[];
      kind: "file" | "directory" | "any";
    }> = [];
    const selected = new Map<string, TreeEntry>();
    for (;;) {
      const deferred: typeof queue = [];
      const missing = new Set<string>();
      for (let group = 0; group < groups.length; group++) {
        if (roots[group]) continue;
        const candidates = groups[group];
        if (!candidates) continue;
        for (;;) {
          const index = indices[group] ?? 0;
          const alias = candidates[index];
          if (!alias) break;
          const resolution = resolvePath(alias, tree, cached);
          if (resolution.isErr()) return err(resolution.error);
          if (resolution.value.phase === "absent") {
            indices[group] = index + 1;
            continue;
          }
          if (resolution.value.phase === "pending") {
            missing.add(resolution.value.oid);
            break;
          }
          roots[group] = { alias, entry: resolution.value.entry };
          queue.push({
            alias,
            path: resolution.value.entry.path,
            seen: [],
            kind: group === 0 ? "file" : "directory",
          });
          break;
        }
      }
      let cursor = 0;
      while (cursor < queue.length) {
        const item = queue[cursor++];
        if (!item) break;
        if (item.alias.length > 1024)
          return err(resourceError("limit", "Resource path length exceeded"));
        const resolution = resolvePath(item.path, tree, cached);
        if (resolution.isErr()) return err(resolution.error);
        if (resolution.value.phase === "absent")
          return err(resourceError("invalid", "Resource symlink target is missing"));
        if (resolution.value.phase === "pending") {
          missing.add(resolution.value.oid);
          deferred.push(item);
          continue;
        }
        const e = resolution.value.entry;
        if (e.mode === "040000") {
          if (item.kind === "file")
            return err(resourceError("invalid", "Instruction resource is not a file"));
          if (item.seen.includes(e.path))
            return err(resourceError("invalid", "Resource directory symlink cycle"));
          const prefix = e.path + "/";
          for (const child of children.get(e.path) ?? [])
            queue.push({
              alias: item.alias + "/" + child.path.slice(prefix.length),
              path: child.path,
              seen: [...item.seen, e.path],
              kind: "any",
            });
        } else if (e.mode === "100644" || e.mode === "100755") {
          if (item.kind === "directory")
            return err(resourceError("invalid", "Skill root is not a directory"));
          selected.set(item.alias, e);
          if (!cached.has(e.oid)) missing.add(e.oid);
        } else return err(resourceError("invalid", "Unsupported resource entry"));
        if (selected.size + queue.length - cursor + deferred.length > (limits.maxPaths ?? 5000))
          return err(resourceError("limit", "Resource path limit exceeded"));
      }
      if (missing.size) {
        const result = await fetch(missing);
        if (result.isErr()) return err(result.error);
      }
      queue.length = 0;
      queue.push(...deferred);
      if (!queue.length && !missing.size) break;
    }
    const files: ResourceFile[] = [];
    for (const [path, e] of selected) {
      const bytes = cached.get(e.oid);
      if (!bytes) return err(resourceError("fetch", "Required resource blob unavailable"));
      files.push({ path, bytes, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    if (
      files.reduce((sum, f) => sum + f.bytes.byteLength, 0) > (limits.maxBytes ?? 32 * 1024 * 1024)
    )
      return err(resourceError("limit", "Expanded resource byte limit exceeded"));
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return ok({
      instructionPath: roots[0]?.alias ?? null,
      skillRoot: roots[1]?.alias ?? null,
      files,
    });
  };
  return ResultAsync.fromPromise(run(), () =>
    resourceError("invalid", "Resource selection failed"),
  ).andThen((result) => result);
}

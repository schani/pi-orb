import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OWNER_SKILL_BUNDLE_MAX_BYTES,
  OWNER_SKILL_BUNDLE_MAX_FILES,
  OWNER_SKILL_MAX_BYTES,
  OWNER_SKILL_PATH_MAX_BYTES,
  type OwnerSkillFile,
} from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, errAsync, ok, Result, ResultAsync } from "neverthrow";
import {
  type OwnerSkillBundle,
  type OwnerSkillError,
  type OwnerSkillSource,
  ownerSkillError,
} from "../../domain/owner-skills.ts";
import { type ResourceError, resourceError } from "../../domain/resources.ts";
import { command } from "./git.ts";

const invalid = (message: string) => ownerSkillError("invalid", message);
const unavailable = (message: string) => ownerSkillError("unavailable", message);
const shaPattern = /^[a-f0-9]{40}$/;
const packLimit = 128 * 1024 * 1024;
const unsafePath = /[\\\p{Cc}]/u;
const decodeUtf8 = Result.fromThrowable(
  (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
  () => invalid("GitHub skill contains invalid UTF-8 text or paths"),
);

function parseSource(url: string) {
  // Inspect the original string: URL normalization would silently erase traversal and default ports.
  const match = /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+)\/tree\/([^/?#]+)\/([^?#]+)$/.exec(
    url,
  );
  if (
    !match ||
    url.length > 4096 ||
    /[\s\\]/.test(url) ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(url)
  )
    return err(invalid("Expected a public GitHub folder URL"));
  const decoded = Result.fromThrowable(
    () => match.slice(1).map((part) => decodeURIComponent(part)),
    () => invalid("Invalid GitHub URL encoding"),
  )();
  if (decoded.isErr()) return err(decoded.error);
  const [owner, repo, ref, folder] = decoded.value;
  if (
    !owner ||
    !repo ||
    !ref ||
    !folder ||
    !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(owner) ||
    !/^[a-zA-Z0-9._-]{1,100}$/.test(repo) ||
    repo === "." ||
    repo === ".."
  )
    return err(invalid("Invalid GitHub repository"));
  if (
    ref.includes("/") ||
    unsafePath.test(ref) ||
    /[%\s~^:?*[]/.test(ref) ||
    ref.startsWith("-") ||
    ref.startsWith(".") ||
    ref.endsWith(".") ||
    ref.endsWith(".lock") ||
    ref.includes("..") ||
    ref.includes("@{") ||
    ref === "@"
  )
    return err(invalid("Unsupported GitHub ref; refs containing slashes require a commit SHA URL"));
  const rawFolder = match[4];
  if (
    !rawFolder ||
    /%2f|%5c/i.test(rawFolder) ||
    folder
      .split("/")
      .some(
        (part) =>
          !part || part === "." || part === ".." || part.includes("%") || unsafePath.test(part),
      )
  )
    return err(invalid("Invalid GitHub folder path"));
  return ok({ remote: `https://github.com/${owner}/${repo}.git`, ref, folder });
}

const configuration = {
  "credential.helper": "",
  "core.askPass": "/dev/null",
  "core.attributesFile": "/dev/null",
  "http.followRedirects": "false",
  "http.extraHeader": "",
  "protocol.allow": "never",
  "protocol.https.allow": "always",
  "fetch.fsckObjects": "true",
  "transfer.fsckObjects": "true",
};
const environment: Record<string, string> = {
  GIT_CONFIG_COUNT: String(Object.keys(configuration).length),
};
for (const [index, [key, value]] of Object.entries(configuration).entries()) {
  environment[`GIT_CONFIG_KEY_${index}`] = key;
  environment[`GIT_CONFIG_VALUE_${index}`] = value;
}

interface Entry {
  path: string;
  oid: string;
  bytes: number;
  executable: boolean;
}
function selectTree(bytes: Buffer): Result<Entry[], OwnerSkillError> {
  const decoded = decodeUtf8(bytes);
  if (decoded.isErr()) return err(decoded.error);
  const entries: Entry[] = [];
  for (const row of decoded.value.split("\0")) {
    if (!row) continue;
    const parsed = /^(\d{6}) (tree|blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(row);
    if (!parsed) return err(invalid("Invalid GitHub skill tree"));
    const [, mode, type, oid, path] = parsed;
    if (
      !path ||
      !oid ||
      unsafePath.test(path) ||
      Buffer.byteLength(path) > OWNER_SKILL_PATH_MAX_BYTES ||
      path.split("/").some((part) => !part || part === "." || part === "..")
    )
      return err(invalid("Skill paths must be normalized relative UTF-8 paths"));
    if (mode === "040000" && type === "tree") continue;
    if ((mode !== "100644" && mode !== "100755") || type !== "blob")
      return err(invalid("GitHub skill folders cannot contain symlinks or submodules"));
    entries.push({ path, oid, bytes: 0, executable: mode === "100755" });
    if (entries.length > OWNER_SKILL_BUNDLE_MAX_FILES)
      return err(invalid("Skill bundle must contain at most 5,000 files"));
  }
  if (!entries.some((entry) => entry.path === "SKILL.md"))
    return err(ownerSkillError("not_found", "GitHub folder has no root SKILL.md"));
  return ok(entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
}

/** Public GitHub only; reads pinned trees/blobs in an isolated bare repository, never a checkout. */
export class GitHubOwnerSkillSource implements OwnerSkillSource {
  private readonly command: typeof command;
  constructor(options: { command?: typeof command } = {}) {
    this.command = options.command ?? command;
  }
  acquire(
    _task: SimulationTask,
    request: { url: string; commitSha?: string },
    callerSignal: AbortSignal = new AbortController().signal,
  ): ResultAsync<OwnerSkillBundle, OwnerSkillError> {
    const parsed = parseSource(request.url);
    if (parsed.isErr()) return errAsync(parsed.error);
    if (request.commitSha !== undefined && !shaPattern.test(request.commitSha))
      return errAsync(invalid("Expected a full lowercase commit SHA"));
    const deadline = AbortSignal.timeout(180_000);
    const signal = AbortSignal.any([callerSignal, deadline]);
    const cancelled = () =>
      unavailable(
        callerSignal.aborted
          ? "GitHub skill acquisition cancelled"
          : "GitHub skill acquisition deadline exceeded",
      );
    const run = async (): Promise<Result<OwnerSkillBundle, OwnerSkillError>> => {
      if (signal.aborted) return err(cancelled());
      const temp = await ResultAsync.fromPromise(
        mkdtemp(join(tmpdir(), "pi-orb-owner-skill-")),
        () => unavailable("GitHub skill staging unavailable"),
      );
      if (temp.isErr()) return err(temp.error);
      const inspectPack = () => {
        const inspect = async (): Promise<Result<number, ResourceError>> => {
          const dir = join(temp.value, "objects", "pack");
          const listed = await ResultAsync.fromPromise(readdir(dir), () =>
            resourceError("fetch", "GitHub skill pack inspection failed"),
          );
          if (listed.isErr()) return err(listed.error);
          let total = 0;
          for (const file of listed.value) {
            const size = await ResultAsync.fromPromise(stat(join(dir, file)), (error) => error);
            if (size.isErr()) {
              // Pack finalization renames temporary files while inspection runs.
              if (
                typeof size.error === "object" &&
                size.error !== null &&
                "code" in size.error &&
                size.error.code === "ENOENT"
              )
                continue;
              return err(resourceError("fetch", "GitHub skill pack inspection failed"));
            }
            total += size.value.size;
          }
          return ok(total);
        };
        return ResultAsync.fromPromise(inspect(), () =>
          resourceError("fetch", "GitHub skill pack inspection failed"),
        ).andThen((result) => result);
      };
      const git = (args: string[], input?: string): ResultAsync<Buffer, OwnerSkillError> =>
        this.command(
          args,
          temp.value,
          environment,
          signal,
          input,
          args[0] === "fetch" ? inspectPack : undefined,
        )
          .mapErr((error) =>
            error.code === "limit"
              ? invalid("GitHub skill acquisition exceeded its Git budget")
              : error.reason === "missing_ref" || error.reason === "repository_not_found"
                ? ownerSkillError("not_found", "Public GitHub repository or ref doesn't exist")
                : unavailable(`GitHub skill operation failed (${args[0] ?? "git"})`),
          )
          .andThen((bytes) =>
            args[0] !== "fetch"
              ? ok(bytes)
              : inspectPack()
                  .mapErr(() => unavailable("GitHub skill pack inspection failed"))
                  .andThen((size) =>
                    size > packLimit
                      ? err(invalid("GitHub skill acquisition exceeded its Git budget"))
                      : ok(bytes),
                  ),
          );
      const acquire = async (): Promise<Result<OwnerSkillBundle, OwnerSkillError>> => {
        const init = await git(["init", "--bare", "--template=", "."]);
        if (init.isErr()) return err(init.error);
        const fetched = await git([
          "fetch",
          "--depth=1",
          "--filter=blob:none",
          "--no-tags",
          "--no-write-fetch-head",
          "--",
          parsed.value.remote,
          `${request.commitSha ?? parsed.value.ref}:refs/owner-skill/target`,
        ]);
        if (fetched.isErr()) return err(fetched.error);
        const resolved = await git(["rev-parse", "--verify", "refs/owner-skill/target^{commit}"]);
        if (resolved.isErr()) return err(resolved.error);
        const commitSha = resolved.value.toString("ascii").trim();
        if (
          !shaPattern.test(commitSha) ||
          (request.commitSha !== undefined && request.commitSha !== commitSha)
        )
          return err(invalid("GitHub commit does not match the requested pin"));
        const tree = await git(["rev-parse", "--verify", `${commitSha}:${parsed.value.folder}`]);
        if (tree.isErr()) return err(ownerSkillError("not_found", "GitHub folder doesn't exist"));
        const treeOid = tree.value.toString("ascii").trim();
        if (!shaPattern.test(treeOid)) return err(invalid("Invalid GitHub folder object"));
        const listing = await git(["ls-tree", "-r", "-t", "-z", treeOid]);
        if (listing.isErr()) return err(invalid("GitHub folder must be a directory"));
        const selected = selectTree(listing.value);
        if (selected.isErr()) return err(selected.error);
        const oids = [...new Set(selected.value.map((entry) => entry.oid))];
        const fetchedBlobs = await git(
          [
            "fetch",
            "--refetch",
            "--no-filter",
            "--no-tags",
            "--no-write-fetch-head",
            "--stdin",
            "--",
            parsed.value.remote,
          ],
          `${oids.join("\n")}\n`,
        );
        if (fetchedBlobs.isErr()) return err(fetchedBlobs.error);
        const sizes = await git(["cat-file", "--batch-check"], `${oids.join("\n")}\n`);
        if (sizes.isErr()) return err(sizes.error);
        const rows = sizes.value.toString("ascii").split("\n");
        if (rows.pop() !== "" || rows.length !== oids.length)
          return err(unavailable("Invalid GitHub skill blob sizes"));
        const lengths = new Map<string, number>();
        for (const [index, oid] of oids.entries()) {
          const row = /^([a-f0-9]{40}) blob ([0-9]+)$/.exec(rows[index] ?? "");
          const size = Number(row?.[2]);
          if (!row || row[1] !== oid || !Number.isSafeInteger(size) || size < 0)
            return err(unavailable("Invalid GitHub skill blob size"));
          lengths.set(oid, size);
        }
        let totalBytes = 0;
        for (const entry of selected.value) {
          entry.bytes = lengths.get(entry.oid) ?? 0;
          totalBytes += entry.bytes;
          if (totalBytes > OWNER_SKILL_BUNDLE_MAX_BYTES)
            return err(invalid("Skill bundle must be at most 8 MiB"));
          if (entry.path === "SKILL.md" && entry.bytes > OWNER_SKILL_MAX_BYTES)
            return err(invalid("Skill must be at most 64 KiB"));
        }
        const batch = await git(["cat-file", "--batch"], `${oids.join("\n")}\n`);
        if (batch.isErr()) return err(batch.error);
        const blobs = new Map<string, Buffer>();
        let offset = 0;
        for (const oid of oids) {
          const newline = batch.value.indexOf(10, offset);
          if (newline < 0) return err(unavailable("Invalid GitHub skill blob batch"));
          const header = /^([a-f0-9]{40}) blob ([0-9]+)$/.exec(
            batch.value.subarray(offset, newline).toString("ascii"),
          );
          if (!header || header[1] !== oid)
            return err(unavailable("GitHub skill blob unavailable"));
          const size = Number(header[2]);
          offset = newline + 1;
          if (
            !Number.isSafeInteger(size) ||
            size < 0 ||
            offset + size >= batch.value.length ||
            batch.value[offset + size] !== 10
          )
            return err(unavailable("Invalid GitHub skill blob size"));
          const bytes = batch.value.subarray(offset, offset + size);
          if (createHash("sha1").update(`blob ${size}\0`).update(bytes).digest("hex") !== oid)
            return err(unavailable("GitHub skill blob integrity check failed"));
          blobs.set(oid, bytes);
          offset += size + 1;
        }
        if (offset !== batch.value.length)
          return err(unavailable("Invalid GitHub skill blob batch trailer"));
        let content = "";
        const files: OwnerSkillFile[] = [];
        for (const entry of selected.value) {
          const bytes = blobs.get(entry.oid);
          if (!bytes || bytes.length !== entry.bytes)
            return err(unavailable("GitHub skill blob does not match its tree"));
          if (entry.path === "SKILL.md") {
            const text = decodeUtf8(bytes);
            if (text.isErr()) return err(text.error);
            content = text.value;
          } else
            files.push({
              path: entry.path,
              base64: bytes.toString("base64"),
              executable: entry.executable,
            });
        }
        return ok({ content, files, source: { url: request.url, commitSha } });
      };
      const result = await ResultAsync.fromPromise(acquire(), () =>
        unavailable("GitHub skill acquisition failed"),
      ).andThen((value) => value);
      const cleanup = await ResultAsync.fromPromise(
        rm(temp.value, { recursive: true, force: true }),
        () => unavailable("GitHub skill staging cleanup failed"),
      );
      return cleanup.isErr() ? err(cleanup.error) : result;
    };
    return ResultAsync.fromPromise(run(), () =>
      unavailable("GitHub skill acquisition failed"),
    ).andThen((result) => (signal.aborted ? err(cancelled()) : result));
  }
}

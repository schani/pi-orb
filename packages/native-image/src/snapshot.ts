import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { err, ok, type Result, ResultAsync } from "neverthrow";

const execFileAsync = promisify(execFile);

export const UPLOADED_SOURCE_PATHS = [
  "package.json",
  "package-lock.json",
  "apps/orb-runtime",
  "packages/protocol",
  "packages/luna",
  "packages/mock-openai",
  "scripts/pi-orb-gcp-identity",
  "infra/native-vm",
] as const;

export const TOOLING_SOURCE_PATHS = ["packages/native-image"] as const;

async function gitFiles(repositoryRoot: string, paths: readonly string[]): Promise<string[]> {
  const result = await execFileAsync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...paths],
    { cwd: repositoryRoot, maxBuffer: 16 * 1024 * 1024 },
  );
  return result.stdout
    .split("\0")
    .filter((path) => path !== "")
    .sort();
}

async function validateFiles(
  repositoryRoot: string,
  files: readonly string[],
): Promise<string | null> {
  for (const file of files) {
    if (file.startsWith("/") || file.split("/").includes(".."))
      return `unsafe source path: ${file}`;
    const metadata = await lstat(resolve(repositoryRoot, file));
    if (!metadata.isFile() || metadata.isSymbolicLink())
      return `source must be a regular file: ${file}`;
  }
  return null;
}

async function inventory(
  root: string,
  files: readonly string[],
): Promise<Readonly<Record<string, string>>> {
  const result: Record<string, string> = {};
  for (const file of files)
    result[file] = createHash("sha256")
      .update(await readFile(resolve(root, file)))
      .digest("hex");
  return result;
}

export interface SourceSnapshot {
  readonly archiveSha256: string;
  readonly inputInventory: Readonly<Record<string, string>>;
  readonly toolingInputInventory: Readonly<Record<string, string>>;
}

export interface SourceSnapshotError {
  readonly type: "source_snapshot_failed" | "source_changed" | "invalid_source";
  readonly message: string;
}

export interface SourceSnapshotOptions {
  readonly repositoryRoot?: string;
  readonly uploadedPaths?: readonly string[];
  readonly toolingPaths?: readonly string[];
  readonly afterArchive?: () => Promise<void>;
}

export function prepareSourceSnapshot(
  outputDir: string,
  options: SourceSnapshotOptions = {},
): ResultAsync<SourceSnapshot, SourceSnapshotError> {
  return ResultAsync.fromPromise(
    (async (): Promise<Result<SourceSnapshot, SourceSnapshotError>> => {
      const repositoryRoot = resolve(options.repositoryRoot ?? ".");
      const uploadedPaths = options.uploadedPaths ?? UPLOADED_SOURCE_PATHS;
      const toolingPaths = options.toolingPaths ?? TOOLING_SOURCE_PATHS;
      const uploadedFiles = await gitFiles(repositoryRoot, uploadedPaths);
      const toolingFiles = await gitFiles(repositoryRoot, toolingPaths);
      const invalid = await validateFiles(repositoryRoot, [...uploadedFiles, ...toolingFiles]);
      if (invalid !== null) return err({ type: "invalid_source", message: invalid });

      await mkdir(outputDir, { recursive: true, mode: 0o700 });
      const archive = resolve(outputDir, "source.tar.gz");
      const list = resolve(outputDir, "source-files.nul");
      const extracted = resolve(outputDir, "source-inventory");
      await writeFile(list, `${uploadedFiles.join("\0")}\0`, { mode: 0o600 });
      await execFileAsync("tar", ["--no-xattrs", "-czf", archive, "--null", "-T", list], {
        cwd: repositoryRoot,
        env: { ...process.env, COPYFILE_DISABLE: "1" },
      });
      await options.afterArchive?.();
      await mkdir(extracted, { mode: 0o700 });
      const extraction = await execFileAsync("tar", ["-xzf", archive, "-C", extracted]);
      if (/extended header|LIBARCHIVE\.xattr/i.test(extraction.stderr))
        return err({
          type: "invalid_source",
          message: "source archive contains extended metadata",
        });

      const inputInventory = await inventory(extracted, uploadedFiles);
      const liveInventory = await inventory(repositoryRoot, uploadedFiles);
      const filesAfterSnapshot = await gitFiles(repositoryRoot, uploadedPaths);
      if (
        JSON.stringify(uploadedFiles) !== JSON.stringify(filesAfterSnapshot) ||
        JSON.stringify(inputInventory) !== JSON.stringify(liveInventory)
      ) {
        return err({
          type: "source_changed",
          message: "source inputs changed while the image snapshot was created",
        });
      }
      const toolingInputInventory = await inventory(repositoryRoot, toolingFiles);
      await rm(extracted, { recursive: true });
      return ok({
        archiveSha256: createHash("sha256")
          .update(await readFile(archive))
          .digest("hex"),
        inputInventory,
        toolingInputInventory,
      });
    })(),
    (cause): SourceSnapshotError => ({
      type: "source_snapshot_failed",
      message: cause instanceof Error ? cause.message : String(cause),
    }),
  ).andThen((result) => result);
}

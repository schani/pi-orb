import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { err, ok, Result, ResultAsync } from "neverthrow";

export interface ReadmeError {
  readonly type: "readme_error";
  readonly message: string;
}

const decodeUtf8 = (bytes: Buffer, maxBytes: number): Result<string, ReadmeError> => {
  const decoded = Result.fromThrowable(
    () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    (): ReadmeError => ({ type: "readme_error", message: "README is not valid UTF-8" }),
  )();
  if (decoded.isErr()) return err(decoded.error);
  let result = "";
  let used = 0;
  for (const character of decoded.value) {
    const size = Buffer.byteLength(character);
    if (used + size > maxBytes) break;
    result += character;
    used += size;
  }
  return ok(result);
};

/** Read one conventional root README without following repository-controlled symlinks. */
export function readRootReadme(
  checkoutDir: string,
  maxBytes: number,
): ResultAsync<string | null, ReadmeError> {
  const run = async (): Promise<Result<string | null, ReadmeError>> => {
    const listed = await ResultAsync.fromPromise(readdir(checkoutDir), (error) => ({
      type: "readme_error" as const,
      message: error instanceof Error ? error.message : String(error),
    }));
    if (listed.isErr()) return err(listed.error);
    const candidate = listed.value
      .filter((name) => /^readme(?:\..+)?$/iu.test(name))
      .sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }))[0];
    if (candidate === undefined) return ok(null);
    const path = resolve(checkoutDir, candidate);
    if (!path.startsWith(`${resolve(checkoutDir)}/`)) return ok(null);
    const metadata = await ResultAsync.fromPromise(lstat(path), (error) => ({
      type: "readme_error" as const,
      message: error instanceof Error ? error.message : String(error),
    }));
    if (metadata.isErr() || !metadata.value.isFile() || metadata.value.isSymbolicLink()) {
      return ok(null);
    }
    const contents = await ResultAsync.fromPromise(
      readFile(join(checkoutDir, candidate)),
      (error) => ({
        type: "readme_error" as const,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    if (contents.isErr()) return err(contents.error);
    return decodeUtf8(contents.value, maxBytes);
  };
  return new ResultAsync(run()).mapErr((error) => error);
}

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { validateRepositoryUrl } from "@pi-orb/protocol";
import { err, Result, ResultAsync } from "neverthrow";

export interface CheckoutError {
  readonly code:
    | "invalid_repository_url"
    | "clone_failed"
    | "checkout_admission_revoked"
    | "resource_acquisition_failed"
    | "checkout_unavailable"
    | "checkout_cancelled";
  readonly message: string;
  readonly retryable: boolean;
}
const execGit = (args: string[], cwd: string): ResultAsync<string, { message: string }> =>
  ResultAsync.fromPromise(
    new Promise<string>((resolve, reject) => {
      execFile(
        "git",
        args,
        {
          cwd,
          timeout: 10 * 60_000,
          env: { ...process.env, GIT_ALLOW_PROTOCOL: "https", GIT_TERMINAL_PROMPT: "0" },
        },
        (error, stdout, stderr) => {
          if (error !== null) reject(new Error(stderr || error.message));
          else resolve(stdout.trim());
        },
      );
    }),
    (cause) => ({ message: cause instanceof Error ? cause.message : String(cause) }),
  );

/** Retained checkout is never reset or recloned on resume. */
export async function prepareCheckout(
  workDir: string,
  repositoryUrl: string,
  initialCommands?: () => Promise<Result<readonly string[][], CheckoutError>>,
): Promise<Result<string, CheckoutError>> {
  const repoDir = join(workDir, "repo");
  if (!existsSync(repoDir)) {
    const url = validateRepositoryUrl(repositoryUrl);
    if (url.isErr())
      return err({ code: "invalid_repository_url", message: url.error.message, retryable: false });
    const tmpDir = join(workDir, ".clone-tmp");
    const cleaned = Result.fromThrowable(
      () => {
        rmSync(tmpDir, { recursive: true, force: true });
        mkdirSync(workDir, { recursive: true });
      },
      (cause) => ({ code: "clone_failed" as const, message: String(cause), retryable: true }),
    )();
    if (cleaned.isErr()) return err(cleaned.error);
    const commands = initialCommands ? await initialCommands() : undefined;
    if (commands && commands.isErr()) return err(commands.error);
    const cloned = await execGit(["clone", "--", url.value.url, tmpDir], workDir);
    if (cloned.isErr())
      return err({ code: "clone_failed", message: cloned.error.message, retryable: true });
    for (const command of commands?.value ?? []) {
      const pinned = await execGit(command, tmpDir);
      if (pinned.isErr())
        return err({ code: "clone_failed", message: pinned.error.message, retryable: true });
    }
    const renamed = Result.fromThrowable(
      () => renameSync(tmpDir, repoDir),
      (cause) => ({ code: "clone_failed" as const, message: String(cause), retryable: true }),
    )();
    if (renamed.isErr()) return err(renamed.error);
  }
  const commit = await execGit(["rev-parse", "HEAD"], repoDir);
  return commit.mapErr((error) => ({
    code: "clone_failed" as const,
    message: error.message,
    retryable: true,
  }));
}

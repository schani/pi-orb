import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { GIT_IDENTITY_RUNTIME_PATH, validateGitIdentity } from "@pi-orb/protocol";
import { err, errAsync, ok, Result, ResultAsync } from "neverthrow";
import type { BrokerEnv } from "../broker/endpoint.ts";

export interface GitIdentityError {
  readonly type: "git_identity_error";
  readonly message: string;
}
const failure = (message: string): GitIdentityError => ({
  type: "git_identity_error",
  message: `Cannot apply git identity: ${message}`,
});

/** Exit 5 is `git config --unset-all` finding nothing to remove. */
/** `cwd` is the orb home: git 2.55 aborts when the inherited working directory is unreadable. */
const gitConfig = (
  environment: NodeJS.ProcessEnv,
  home: string,
  args: string[],
  allowedExit?: number,
) =>
  ResultAsync.fromPromise(
    promisify(execFile)("git", ["config", ...args], { env: environment, cwd: home }),
    (error) => (error as { code?: unknown }).code,
  ).orElse((code) =>
    code === allowedExit ? ok(undefined) : err(failure(`git config exited ${String(code)}`)),
  );

const fsStep = Result.fromThrowable(
  (step: () => void) => step(),
  () => failure("cannot write git configuration"),
);

/**
 * One bounded read of the project owner's identity, written to git's XDG global
 * file. `~/.gitconfig` is created empty but never touched afterwards: it
 * outranks the XDG file and receives in-orb `git config --global` writes, so
 * those survive the next boot (docs/git-identity.md).
 */
export function applyGitIdentity(
  broker: BrokerEnv,
  home: string,
  environment: NodeJS.ProcessEnv,
): ResultAsync<void, GitIdentityError> {
  const file = join(environment.XDG_CONFIG_HOME || join(home, ".config"), "git", "config");
  return ResultAsync.fromPromise(
    fetch(`${broker.controlPlaneUrl}${GIT_IDENTITY_RUNTIME_PATH}`, {
      headers: { authorization: `Bearer ${broker.runtimeToken}` },
      signal: AbortSignal.timeout(10_000),
    }),
    () => failure("control plane unavailable"),
  )
    .andThen((response) =>
      response.ok
        ? ResultAsync.fromPromise(response.json(), () => failure("invalid identity"))
        : errAsync(failure(`HTTP ${response.status}`)),
    )
    .andThen((body) => validateGitIdentity(body).mapErr(() => failure("invalid identity")))
    .andThen((identity) =>
      fsStep(() => mkdirSync(dirname(file), { recursive: true }))
        .asyncAndThen(() => setOrUnset(environment, home, file, "user.name", identity.name))
        .andThen(() => setOrUnset(environment, home, file, "user.email", identity.email)),
    )
    .andThen(() => fsStep(() => writeFileSync(join(home, ".gitconfig"), "", { flag: "a" })));
}

const setOrUnset = (
  environment: NodeJS.ProcessEnv,
  home: string,
  file: string,
  key: string,
  value: string,
) =>
  value === ""
    ? gitConfig(environment, home, ["--file", file, "--unset-all", key], 5)
    : gitConfig(environment, home, ["--file", file, "--replace-all", key, value]);

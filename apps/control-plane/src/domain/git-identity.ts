import { type GitIdentity, validateGitIdentity } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { errAsync, type ResultAsync } from "neverthrow";

export interface GitIdentityError {
  readonly type: "git_identity_error";
  readonly code: "invalid" | "unavailable" | "internal";
  readonly message: string;
}
/** Per-user, last-write-wins; a user without a row reads as cleared. */
export interface GitIdentityStore {
  read(task: SimulationTask, userId: string): ResultAsync<GitIdentity, GitIdentityError>;
  replace(
    task: SimulationTask,
    userId: string,
    identity: GitIdentity,
  ): ResultAsync<GitIdentity, GitIdentityError>;
}
export function saveGitIdentity(
  task: SimulationTask,
  store: GitIdentityStore,
  userId: string,
  body: unknown,
) {
  const identity = validateGitIdentity(body);
  return identity.isErr()
    ? errAsync<GitIdentity, GitIdentityError>({
        type: "git_identity_error",
        code: "invalid",
        message: identity.error.message,
      })
    : store.replace(task, userId, identity.value);
}

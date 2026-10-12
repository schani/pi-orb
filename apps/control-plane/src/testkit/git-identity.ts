import type { GitIdentity } from "@pi-orb/protocol";
import { okAsync } from "neverthrow";
import type { GitIdentityStore } from "../domain/git-identity.ts";

export class FakeGitIdentityStore implements GitIdentityStore {
  readonly identities = new Map<string, GitIdentity>();
  read(_task: unknown, userId: string) {
    return okAsync(this.identities.get(userId) ?? { name: "", email: "" });
  }
  replace(_task: unknown, userId: string, identity: GitIdentity) {
    this.identities.set(userId, identity);
    return okAsync(identity);
  }
}

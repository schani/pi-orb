import type { SimulationTask } from "determined";
import { errAsync, type ResultAsync } from "neverthrow";
import type { PointerConflict, StoreError } from "../domain/errors.ts";
import type {
  CredentialPointerRow,
  CredentialPointerWrite,
  StoredCredential,
  StoredSecret,
} from "../domain/ports.ts";
import { FakePointerStore, FakeSecretStore } from "./broker.ts";

const unavailable = (message: string): StoreError => ({
  type: "store_error",
  code: "unavailable",
  message,
  retryable: true,
});

/** Lands the first CAS, supersedes it, then loses its acknowledgement. */
export class SupersedingLoginPointerStore extends FakePointerStore {
  casCalls = 0;
  private readonly winner: CredentialPointerRow;

  constructor(winner: CredentialPointerRow) {
    super();
    this.winner = winner;
  }

  override casWritePointer(
    task: SimulationTask,
    provider: string,
    expectedRowVersion: number | null,
    next: CredentialPointerWrite,
  ): ResultAsync<CredentialPointerRow, StoreError | PointerConflict> {
    this.casCalls += 1;
    if (this.casCalls !== 1) return super.casWritePointer(task, provider, expectedRowVersion, next);
    return super.casWritePointer(task, provider, expectedRowVersion, next).andThen(() => {
      this.seedRow(this.winner);
      return errAsync(unavailable("lost login publication acknowledgement"));
    });
  }
}

/** Rejects the first immutable secret write, before pointer publication is possible. */
export class PreCommitFailureSecretStore extends FakeSecretStore {
  writeCalls = 0;
  readonly retriedCredentials: StoredSecret[] = [];

  override writeSecret<T extends StoredSecret = StoredCredential>(
    task: SimulationTask,
    provider: string,
    credential: T,
  ): ResultAsync<{ version: string }, StoreError> {
    this.writeCalls += 1;
    if (this.writeCalls === 1) return errAsync(unavailable("known pre-commit failure"));
    this.retriedCredentials.push(credential);
    return super.writeSecret(task, provider, credential);
  }
}

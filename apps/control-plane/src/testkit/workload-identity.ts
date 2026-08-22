import { ApplicationFailure, type SimulationTask } from "determined";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import type { SigningKeyConflict, StoreError } from "../domain/errors.ts";
import type { CasSigningKeyStateParams, SigningKeyRow, SigningKeyStore } from "../domain/ports.ts";
import { FAILPOINTS } from "./failpoints.ts";

const unavailable = (message: string): StoreError => ({
  type: "store_error",
  code: "unavailable",
  message,
  retryable: true,
});

/** A shape the schema refuses outright, so no retry can repair it. */
const corruption = (message: string): StoreError => ({
  type: "store_error",
  code: "corruption",
  message,
  retryable: false,
});

function accessGate<T>(
  task: SimulationTask,
  failpoint: string,
  reason: string,
  f: () => T,
): ResultAsync<T, StoreError> {
  const run = async (): Promise<T> => {
    await task.sleep(1 + task.random(`signing key latency: ${reason}`) * 5, reason);
    await task.failpoint(failpoint, reason);
    return f();
  };
  return ResultAsync.fromPromise(run(), (error) => {
    if (error instanceof ApplicationFailure) return unavailable(`${reason}: ${error.message}`);
    return task.abortSimulation(error);
  });
}

/**
 * Deterministic in-memory `SigningKeyStore` with the semantics the PostgreSQL
 * adapter must implement (docs/workload-identity.md), including the two shapes
 * its schema refuses: a duplicate `kid` and a second active key.
 */
export class FakeSigningKeyStore implements SigningKeyStore {
  private readonly rows = new Map<string, SigningKeyRow>();

  /** Simulates leftovers of another instance: an unfenced direct write. */
  seedKey(row: SigningKeyRow): void {
    this.rows.set(row.kid, row);
  }

  snapshot(kid: string): SigningKeyRow | null {
    return this.rows.get(kid) ?? null;
  }

  listSigningKeys(task: SimulationTask): ResultAsync<SigningKeyRow[], StoreError> {
    return accessGate(task, FAILPOINTS.signingKeyRead, "list signing keys", () =>
      [...this.rows.values()].sort(
        (left, right) => left.createdAt - right.createdAt || compareKid(left.kid, right.kid),
      ),
    );
  }

  insertSigningKey(
    task: SimulationTask,
    row: SigningKeyRow,
  ): ResultAsync<SigningKeyRow, StoreError> {
    return accessGate(task, FAILPOINTS.signingKeyWrite, "insert signing key", () => {
      if (this.rows.has(row.kid)) {
        return { refused: corruption(`duplicate signing key ${row.kid}`) };
      }
      if (row.state === "active" && this.activeKid(row.kid) !== null) {
        return { refused: corruption(`signing key ${row.kid} would be a second active key`) };
      }
      this.rows.set(row.kid, row);
      return { refused: null, row };
    }).andThen((outcome) =>
      outcome.refused !== null ? errAsync(outcome.refused) : okAsync(outcome.row),
    );
  }

  casSigningKeyState(
    task: SimulationTask,
    params: CasSigningKeyStateParams,
  ): ResultAsync<SigningKeyRow, StoreError | SigningKeyConflict> {
    return accessGate(task, FAILPOINTS.signingKeyWrite, "cas signing key state", () => {
      const current = this.rows.get(params.kid);
      if (current === undefined || current.rowVersion !== params.expectedRowVersion) {
        return { refused: { type: "signing_key_conflict" as const } };
      }
      if (params.state === "active" && this.activeKid(params.kid) !== null) {
        return { refused: corruption(`signing key ${params.kid} would be a second active key`) };
      }
      const updated: SigningKeyRow = {
        ...current,
        state: params.state,
        rowVersion: current.rowVersion + 1,
        ...(params.activatedAt !== undefined ? { activatedAt: params.activatedAt } : {}),
        ...(params.retiredAt !== undefined ? { retiredAt: params.retiredAt } : {}),
      };
      this.rows.set(params.kid, updated);
      return { refused: null, row: updated };
    }).andThen((outcome) =>
      outcome.refused !== null
        ? errAsync<SigningKeyRow, StoreError | SigningKeyConflict>(outcome.refused)
        : okAsync(outcome.row),
    );
  }

  /** The active key other than `exceptKid`, which is the row being written. */
  private activeKid(exceptKid: string): string | null {
    for (const row of this.rows.values()) {
      if (row.state === "active" && row.kid !== exceptKid) return row.kid;
    }
    return null;
  }
}

const compareKid = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

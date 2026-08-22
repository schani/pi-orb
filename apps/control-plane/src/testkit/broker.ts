import { ApplicationFailure, type SimulationTask } from "determined";
import { errAsync, ResultAsync } from "neverthrow";
import type { PointerConflict, StoreError, UpstreamRefreshError } from "../domain/errors.ts";
import type {
  CredentialPointerRow,
  CredentialPointerStore,
  CredentialPointerWrite,
  CredentialSecretStore,
  OperationContext,
  StoredCredential,
  StoredSecret,
  UpstreamRefresher,
} from "../domain/ports.ts";
import { FAILPOINTS } from "./failpoints.ts";

const unavailable = (message: string): StoreError => ({
  type: "store_error",
  code: "unavailable",
  message,
  retryable: true,
});

function accessGate<T>(
  task: SimulationTask,
  failpoint: string,
  reason: string,
  maxLatencyMs: number,
  f: () => T,
): ResultAsync<T, StoreError> {
  const run = async (): Promise<T> => {
    await task.sleep(1 + task.random(`broker latency: ${reason}`) * maxLatencyMs, reason);
    await task.failpoint(failpoint, reason);
    return f();
  };
  return ResultAsync.fromPromise(run(), (error) => {
    if (error instanceof ApplicationFailure) return unavailable(`${reason}: ${error.message}`);
    return task.abortSimulation(error);
  });
}

/**
 * Deterministic in-memory credential-pointer store with the CAS semantics the
 * PostgreSQL adapter must implement, including the write-landed-but-caller-
 * errored shape via the `write.after` failpoint. Tracks every committed write
 * so tests can assert generation monotonicity.
 */
export class FakePointerStore implements CredentialPointerStore {
  private readonly rows = new Map<string, CredentialPointerRow>();
  readonly committedWrites: CredentialPointerRow[] = [];

  snapshot(provider: string): CredentialPointerRow | null {
    return this.rows.get(provider) ?? null;
  }

  /** Simulates leftovers of a crashed instance: an unfenced direct write. */
  seedRow(row: CredentialPointerRow): void {
    this.rows.set(row.provider, row);
  }

  assertGenerationMonotonic(): void {
    let last = -1;
    for (const write of this.committedWrites) {
      if (write.generation < last) {
        throw new Error(
          `generation regressed: ${last} -> ${write.generation} (writes: ${JSON.stringify(this.committedWrites)})`,
        );
      }
      last = write.generation;
    }
  }

  readPointer(
    task: SimulationTask,
    provider: string,
  ): ResultAsync<CredentialPointerRow | null, StoreError> {
    return accessGate(task, FAILPOINTS.brokerPointerRead, "read pointer", 5, () => {
      return this.rows.get(provider) ?? null;
    });
  }

  casWritePointer(
    task: SimulationTask,
    provider: string,
    expectedRowVersion: number | null,
    next: CredentialPointerWrite,
  ): ResultAsync<CredentialPointerRow, StoreError | PointerConflict> {
    const before = accessGate(
      task,
      FAILPOINTS.brokerPointerWriteBefore,
      "cas pointer (before)",
      5,
      () => undefined,
    );
    return before.andThen(() => {
      const current = this.rows.get(provider) ?? null;
      const currentVersion = current?.rowVersion ?? null;
      if (currentVersion !== expectedRowVersion) {
        return errAsync<CredentialPointerRow, StoreError | PointerConflict>({
          type: "pointer_conflict",
        });
      }
      const written: CredentialPointerRow = {
        provider,
        rowVersion: (currentVersion ?? 0) + 1,
        generation: next.generation,
        secretVersion: next.secretVersion,
        refreshLeaseUntil: next.refreshLeaseUntil,
        lastRefreshAt: next.lastRefreshAt,
      };
      this.rows.set(provider, written);
      this.committedWrites.push(written);
      // The commit landed; a failure past this point reaches the caller as an
      // error while the write stays.
      return accessGate(
        task,
        FAILPOINTS.brokerPointerWriteAfter,
        "cas pointer (after)",
        1,
        () => written,
      );
    });
  }
}

/**
 * Deterministic in-memory secret store with immutable versions. The failpoint
 * names are constructor parameters because the store has two independent
 * users — the credential broker and the issuer's signing keys — whose outages
 * a scenario must be able to inject separately.
 */
export class FakeSecretStore implements CredentialSecretStore {
  private readonly versions = new Map<string, StoredSecret>();
  private readonly destroyed = new Set<string>();
  private counter = 0;
  /** When true, every write fails after the failpoint gate (loss-window tests). */
  failWrites = false;
  private readonly readFailpoint: string;
  private readonly writeFailpoint: string;

  constructor(failpoints?: { read: string; write: string }) {
    this.readFailpoint = failpoints?.read ?? FAILPOINTS.brokerSecretRead;
    this.writeFailpoint = failpoints?.write ?? FAILPOINTS.brokerSecretWrite;
  }

  seedSecret(provider: string, credential: StoredSecret): string {
    this.counter += 1;
    const version = `v${this.counter}`;
    this.versions.set(`${provider}/${version}`, credential);
    return version;
  }

  destroyedVersions(): string[] {
    return [...this.destroyed];
  }

  /** Versions written under `provider` that still hold material. */
  liveVersions(provider: string): string[] {
    const prefix = `${provider}/`;
    return [...this.versions.keys()]
      .filter((key) => key.startsWith(prefix) && !this.destroyed.has(key))
      .map((key) => key.slice(prefix.length));
  }

  writeSecret<T extends StoredSecret = StoredCredential>(
    task: SimulationTask,
    provider: string,
    credential: T,
  ): ResultAsync<{ version: string }, StoreError> {
    return accessGate(task, this.writeFailpoint, "write secret", 5, () => {
      if (this.failWrites) throw new ApplicationFailure("secret write refused");
      return { version: this.seedSecret(provider, credential) };
    });
  }

  readSecret<T extends StoredSecret = StoredCredential>(
    task: SimulationTask,
    provider: string,
    version: string,
  ): ResultAsync<T | null, StoreError> {
    return accessGate(task, this.readFailpoint, "read secret", 5, () => {
      const key = `${provider}/${version}`;
      if (this.destroyed.has(key)) return null;
      return (this.versions.get(key) ?? null) as T | null;
    });
  }

  destroySecret(
    task: SimulationTask,
    provider: string,
    version: string,
  ): ResultAsync<void, StoreError> {
    return accessGate(task, this.writeFailpoint, "destroy secret", 5, () => {
      this.destroyed.add(`${provider}/${version}`);
    });
  }
}

export type UpstreamScript =
  /** Rotate and return the new credential. */
  | { readonly kind: "ok" }
  /** Fail without touching upstream state. */
  | { readonly kind: "transient" }
  /** Rotate upstream state, then fail: the response was lost. */
  | { readonly kind: "apply_then_transient" }
  /** Take this long before following the next scripted step. */
  | { readonly kind: "delay"; readonly ms: number }
  /**
   * Causal gate: proceed to the next step only once `ready()` holds. Unlike
   * a delay, this survives adversarial timer scheduling — the ordering it
   * enforces is by causality, not by time.
   */
  | { readonly kind: "until"; readonly ready: () => boolean }
  /** Never respond; settle as transient only when the deadline aborts. */
  | { readonly kind: "hang" };

/**
 * Deterministic upstream with strict refresh-token rotation: only the most
 * recently issued refresh token works, exactly like a rotating OAuth
 * provider. `calls` counts attempts that reached the upstream.
 */
export class FakeUpstream implements UpstreamRefresher {
  private script: UpstreamScript[] = [];
  private issued = 0;
  private currentRefresh: string;
  calls = 0;

  readonly accessTtlMs: number;

  constructor(initialRefresh: string, accessTtlMs: number = 3_600_000) {
    this.currentRefresh = initialRefresh;
    this.accessTtlMs = accessTtlMs;
  }

  /** Queue behaviors for upcoming calls; when empty, calls behave as "ok". */
  pushScript(...steps: UpstreamScript[]): void {
    this.script.push(...steps);
  }

  /** Invalidate every outstanding refresh token (account-side revocation). */
  revokeAll(): void {
    this.issued += 1;
    this.currentRefresh = `revoked-${this.issued}`;
  }

  /** The refresh token a freshly logged-in credential would carry. */
  adoptLogin(credential: StoredCredential): void {
    this.currentRefresh = credential.refresh;
  }

  private rotate(task: SimulationTask, accountId: string): StoredCredential {
    this.issued += 1;
    const credential: StoredCredential = {
      access: `access-${this.issued}`,
      refresh: `refresh-${this.issued}`,
      accountId,
      expiresAt: task.wallNow() + this.accessTtlMs,
    };
    this.currentRefresh = credential.refresh;
    return credential;
  }

  refresh(
    task: SimulationTask,
    credential: StoredCredential,
    context: OperationContext,
  ): ResultAsync<StoredCredential, UpstreamRefreshError> {
    const run = async (): Promise<StoredCredential> => {
      for (;;) {
        await task.sleep(1 + task.random("upstream latency") * 20, "upstream refresh");
        const step = this.script.shift() ?? { kind: "ok" };
        if (step.kind === "delay") {
          await task.sleep(step.ms, "scripted upstream delay");
          continue;
        }
        if (step.kind === "until") {
          while (!step.ready()) {
            await task.sleep(50, "scripted upstream gate");
          }
          continue;
        }
        if (step.kind === "hang") {
          await new Promise<never>((_, reject) => {
            if (context.signal.aborted) {
              reject(new ApplicationFailure("upstream hang aborted"));
              return;
            }
            context.signal.addEventListener(
              "abort",
              () => reject(new ApplicationFailure("upstream hang aborted")),
              { once: true },
            );
          });
        }
        this.calls += 1;
        if (step.kind === "transient") {
          throw new ApplicationFailure("scripted transient");
        }
        if (credential.refresh !== this.currentRefresh) {
          const error: UpstreamRefreshError = {
            type: "invalid_grant",
            message: "refresh token is not current",
          };
          throw new ApplicationFailure(JSON.stringify(error));
        }
        const rotated = this.rotate(task, credential.accountId);
        if (step.kind === "apply_then_transient") {
          throw new ApplicationFailure("response lost after rotation");
        }
        return rotated;
      }
    };
    return ResultAsync.fromPromise(run(), (error): UpstreamRefreshError => {
      if (error instanceof ApplicationFailure) {
        if (error.message.startsWith("{")) {
          return JSON.parse(error.message) as UpstreamRefreshError;
        }
        return { type: "upstream_transient", message: error.message };
      }
      return task.abortSimulation(error);
    });
  }
}

let credentialCounter = 0;

export function makeCredential(
  task: SimulationTask,
  options?: { expiresInMs?: number; accountId?: string },
): StoredCredential {
  credentialCounter += 1;
  return {
    access: `seed-access-${credentialCounter}`,
    refresh: `seed-refresh-${credentialCounter}`,
    accountId: options?.accountId ?? "acct_test",
    expiresAt: task.wallNow() + (options?.expiresInMs ?? 3_600_000),
  };
}

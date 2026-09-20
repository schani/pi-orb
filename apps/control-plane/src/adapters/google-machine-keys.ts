import type { SimulationTask } from "determined";
import { errAsync, okAsync, type Result, ResultAsync } from "neverthrow";
import type { IdentityVerificationError } from "../domain/identity.ts";

export interface GoogleKeySet {
  readonly keys: Record<string, string>;
  readonly maxAgeMs: number;
}
export type GoogleKeyFetcher = (
  task: SimulationTask,
) => ResultAsync<GoogleKeySet, IdentityVerificationError>;
export type GoogleKeyProviderOutcome =
  | { readonly type: "google_key_provider_outage" }
  | { readonly type: "google_key_provider_recovered" };

/** Per-process singleflight, bounded cache and cooldown (including outages). */
export class GoogleMachineKeys {
  private cached: GoogleKeySet | null = null;
  private expiresAt = 0;
  private refreshAfter = 0;
  private inFlight: Promise<Result<GoogleKeySet, IdentityVerificationError>> | null = null;
  private readonly fetch: GoogleKeyFetcher;
  private readonly now: () => number;
  private offline = false;
  private readonly onOutcome: ((outcome: GoogleKeyProviderOutcome) => void) | undefined;
  constructor(
    fetch: GoogleKeyFetcher,
    now: () => number,
    onOutcome?: (outcome: GoogleKeyProviderOutcome) => void,
  ) {
    this.onOutcome = onOutcome;
    this.fetch = fetch;
    this.now = now;
  }
  get(task: SimulationTask, kid: string): ResultAsync<GoogleKeySet, IdentityVerificationError> {
    const fresh = this.cached !== null && this.now() < this.expiresAt;
    if (fresh && this.cached && Object.hasOwn(this.cached.keys, kid)) return okAsync(this.cached);
    if (this.inFlight) return new ResultAsync(this.inFlight);
    if (fresh && this.cached && this.now() < this.refreshAfter) return okAsync(this.cached);
    if (!fresh && this.now() < this.refreshAfter)
      return errAsync({ type: "identity_unavailable", message: "Google keys unavailable" });
    this.refreshAfter = this.now() + 30_000;
    const pending = (async (): Promise<Result<GoogleKeySet, IdentityVerificationError>> => {
      const result = await this.fetch(task);
      this.inFlight = null;
      const offline = result.isErr();
      if (offline !== this.offline) {
        this.offline = offline;
        this.onOutcome?.({
          type: offline ? "google_key_provider_outage" : "google_key_provider_recovered",
        });
      }
      if (result.isOk()) {
        this.cached = result.value;
        this.expiresAt = this.now() + Math.max(0, Math.min(result.value.maxAgeMs, 3_600_000));
      }
      return result;
    })();
    this.inFlight = pending;
    return new ResultAsync(pending);
  }
}

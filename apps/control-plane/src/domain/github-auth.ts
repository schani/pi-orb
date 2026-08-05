import type { SimulationTask } from "determined";
import { ResultAsync } from "neverthrow";
import { commitLoginCredential, GITHUB_PROVIDER } from "./broker.ts";
import type { AuthGateError } from "./errors.ts";
import type {
  AuthGate,
  AuthResolution,
  BrokerDeps,
  DeviceChallenge,
  StoredCredential,
} from "./ports.ts";

/**
 * GitHub device-flow auth gate (docs/credentials.md). Unlike the Pi gate, the
 * flow has no background driver: every `ensureAuth` call — the reconciler's
 * cadence — advances it by at most one poll, respecting the device-flow
 * interval (and GitHub's `slow_down` backoff). That makes the whole ceremony
 * deterministically simulable. The refresh token reaches only
 * `commitLoginCredential`; nothing here returns secret material.
 */

export interface GithubDeviceGrant {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly intervalMs: number;
  /** Wall-clock ms. */
  readonly expiresAt: number;
}

export type GithubPollOutcome =
  | { readonly kind: "authorized"; readonly credential: StoredCredential }
  | { readonly kind: "pending" }
  | { readonly kind: "slow_down" }
  | { readonly kind: "expired" }
  | { readonly kind: "denied" };

export interface GithubOAuthTransientError {
  readonly type: "github_oauth_transient";
  readonly message: string;
}

export interface GithubOAuthClient {
  requestDeviceCode(
    task: SimulationTask,
  ): ResultAsync<GithubDeviceGrant, GithubOAuthTransientError>;
  pollDeviceToken(
    task: SimulationTask,
    deviceCode: string,
  ): ResultAsync<GithubPollOutcome, GithubOAuthTransientError>;
}

/** GitHub's device-flow `slow_down` asks for 5 extra seconds between polls. */
const SLOW_DOWN_INCREMENT_MS = 5_000;

interface ActiveFlow {
  readonly device: GithubDeviceGrant;
  intervalMs: number;
  /** Wall-clock ms before which no poll happens. */
  nextPollAt: number;
  /** Authorized but not yet durably committed (commit retries reuse it). */
  pendingCredential: StoredCredential | null;
}

export class GithubAuthGate implements AuthGate {
  private readonly broker: BrokerDeps;
  private readonly client: GithubOAuthClient;
  private flow: ActiveFlow | null = null;

  constructor(broker: BrokerDeps, client: GithubOAuthClient) {
    this.broker = broker;
    this.client = client;
  }

  private challenge(flow: ActiveFlow): DeviceChallenge {
    return {
      provider: "github",
      verificationUri: flow.device.verificationUri,
      userCode: flow.device.userCode,
      expiresAt: flow.device.expiresAt,
    };
  }

  private async commit(task: SimulationTask, flow: ActiveFlow): Promise<AuthResolution> {
    const credential = flow.pendingCredential;
    if (credential === null) return { status: "failed", message: "no credential", retryable: true };
    const committed = await commitLoginCredential(task, this.broker, GITHUB_PROVIDER, credential);
    if (committed.isErr()) {
      // The device code is consumed; keep the credential for the next try
      // instead of forcing a fresh ceremony.
      return { status: "failed", message: committed.error.message, retryable: true };
    }
    this.flow = null;
    return { status: "ok" };
  }

  ensureAuth(task: SimulationTask): ResultAsync<AuthResolution, AuthGateError> {
    const run = async (): Promise<AuthResolution> => {
      // The pointer is the durable authority: once a credential exists, no
      // ceremony runs (an invalid_grant clears it, which re-opens the flow).
      const pointer = await this.broker.pointers.readPointer(task, GITHUB_PROVIDER);
      if (pointer.isErr()) {
        return { status: "failed", message: pointer.error.message, retryable: true };
      }
      if (pointer.value?.secretVersion != null) {
        this.flow = null;
        return { status: "ok" };
      }

      let flow = this.flow;
      if (flow !== null && flow.pendingCredential !== null) return this.commit(task, flow);

      if (flow === null) {
        const grant = await this.client.requestDeviceCode(task);
        if (grant.isErr()) {
          return { status: "failed", message: grant.error.message, retryable: true };
        }
        flow = {
          device: grant.value,
          intervalMs: grant.value.intervalMs,
          nextPollAt: task.wallNow() + grant.value.intervalMs,
          pendingCredential: null,
        };
        this.flow = flow;
        return { status: "pending", challenge: this.challenge(flow) };
      }

      const now = task.wallNow();
      if (now >= flow.device.expiresAt) {
        this.flow = null;
        return { status: "failed", message: "GitHub device code expired", retryable: true };
      }
      if (now < flow.nextPollAt) return { status: "pending", challenge: this.challenge(flow) };

      const polled = await this.client.pollDeviceToken(task, flow.device.deviceCode);
      const after = task.wallNow();
      if (polled.isErr()) {
        flow.nextPollAt = after + flow.intervalMs;
        return { status: "pending", challenge: this.challenge(flow) };
      }
      const outcome = polled.value;
      switch (outcome.kind) {
        case "authorized":
          flow.pendingCredential = outcome.credential;
          return this.commit(task, flow);
        case "pending":
          flow.nextPollAt = after + flow.intervalMs;
          return { status: "pending", challenge: this.challenge(flow) };
        case "slow_down":
          flow.intervalMs += SLOW_DOWN_INCREMENT_MS;
          flow.nextPollAt = after + flow.intervalMs;
          return { status: "pending", challenge: this.challenge(flow) };
        case "expired":
          this.flow = null;
          return { status: "failed", message: "GitHub device code expired", retryable: true };
        case "denied":
          this.flow = null;
          return { status: "failed", message: "GitHub authorization denied", retryable: true };
      }
    };
    return ResultAsync.fromPromise(
      run(),
      (error): AuthGateError => ({
        type: "auth_gate_error",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      }),
    );
  }
}

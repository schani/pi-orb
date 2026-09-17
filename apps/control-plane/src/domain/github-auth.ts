import type { SimulationTask } from "determined";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import { commitLoginCredential, GITHUB_PROVIDER, getToken } from "./broker.ts";
import type { AuthGateError } from "./errors.ts";
import type {
  AuthGate,
  AuthResolution,
  BrokerDeps,
  DeviceChallenge,
  StoredCredential,
} from "./ports.ts";

export interface GithubDeviceGrant {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly intervalMs: number;
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

const SLOW_DOWN_INCREMENT_MS = 5_000;

interface ActiveFlow {
  readonly device: GithubDeviceGrant;
  intervalMs: number;
  nextPollAt: number;
  pendingCredential: StoredCredential | null;
}

const gateError = (message: string): AuthGateError => ({
  type: "auth_gate_error",
  message,
  retryable: true,
});

export class GithubAuthGate implements AuthGate {
  private readonly brokerForUser: (userId: string) => BrokerDeps;
  private readonly client: GithubOAuthClient;
  private readonly flows = new Map<string, ActiveFlow>();

  constructor(brokerForUser: (userId: string) => BrokerDeps, client: GithubOAuthClient) {
    this.brokerForUser = brokerForUser;
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

  private async commit(
    task: SimulationTask,
    userId: string,
    flow: ActiveFlow,
  ): Promise<Result<AuthResolution, AuthGateError>> {
    const credential = flow.pendingCredential;
    if (credential === null) return err(gateError("no pending credential"));
    const committed = await commitLoginCredential(
      task,
      this.brokerForUser(userId),
      GITHUB_PROVIDER,
      credential,
    );
    if (committed.isErr()) {
      if (committed.error.type === "login_commit_uncertain") this.flows.delete(userId);
      return err(gateError(committed.error.message));
    }
    this.flows.delete(userId);
    return ok({ status: "ok" });
  }

  ensureAuth(task: SimulationTask, userId: string): ResultAsync<AuthResolution, AuthGateError> {
    const run = async (): Promise<Result<AuthResolution, AuthGateError>> => {
      const broker = this.brokerForUser(userId);
      const token = await getToken(task, broker, GITHUB_PROVIDER, { reason: "startup" });
      if (token.isOk()) {
        this.flows.delete(userId);
        return ok({ status: "ok" });
      }
      if (token.error.type !== "auth_required") return err(gateError(token.error.message));

      let flow = this.flows.get(userId) ?? null;
      if (flow !== null && flow.pendingCredential !== null) return this.commit(task, userId, flow);

      if (flow === null) {
        const grant = await this.client.requestDeviceCode(task);
        if (grant.isErr()) return err(gateError(grant.error.message));
        flow = {
          device: grant.value,
          intervalMs: grant.value.intervalMs,
          nextPollAt: task.wallNow() + grant.value.intervalMs,
          pendingCredential: null,
        };
        this.flows.set(userId, flow);
        return ok({ status: "pending", challenge: this.challenge(flow) });
      }

      const now = task.wallNow();
      if (now >= flow.device.expiresAt) {
        this.flows.delete(userId);
        return ok({ status: "failed", message: "GitHub device code expired", retryable: false });
      }
      if (now < flow.nextPollAt) {
        return ok({ status: "pending", challenge: this.challenge(flow) });
      }

      const polled = await this.client.pollDeviceToken(task, flow.device.deviceCode);
      const after = task.wallNow();
      if (polled.isErr()) {
        flow.nextPollAt = after + flow.intervalMs;
        return ok({ status: "pending", challenge: this.challenge(flow) });
      }
      switch (polled.value.kind) {
        case "authorized":
          flow.pendingCredential = polled.value.credential;
          return this.commit(task, userId, flow);
        case "pending":
          flow.nextPollAt = after + flow.intervalMs;
          return ok({ status: "pending", challenge: this.challenge(flow) });
        case "slow_down":
          flow.intervalMs += SLOW_DOWN_INCREMENT_MS;
          flow.nextPollAt = after + flow.intervalMs;
          return ok({ status: "pending", challenge: this.challenge(flow) });
        case "expired":
          this.flows.delete(userId);
          return ok({ status: "failed", message: "GitHub device code expired", retryable: false });
        case "denied":
          this.flows.delete(userId);
          return ok({ status: "failed", message: "GitHub authorization denied", retryable: false });
      }
    };
    return ResultAsync.fromPromise(
      run(),
      (error): AuthGateError => gateError(String(error)),
    ).andThen((result) => result);
  }
}

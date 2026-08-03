import { ApplicationFailure, type SimulationTask } from "determined";
import { ResultAsync } from "neverthrow";
import type {
  GithubDeviceGrant,
  GithubOAuthClient,
  GithubOAuthTransientError,
  GithubPollOutcome,
} from "../domain/github-auth.ts";
import type { StoredCredential } from "../domain/ports.ts";
import { FAILPOINTS } from "./failpoints.ts";

const transient = (message: string): GithubOAuthTransientError => ({
  type: "github_oauth_transient",
  message,
});

/**
 * Deterministic GitHub device-flow client. State-based by default — polls
 * report `pending` until `authorize()` (or `deny()`) — with an optional
 * scripted-outcome queue consumed first. Records device-code requests and
 * poll wall-clock times so tests can assert flow restarts and poll pacing.
 */
export class FakeGithubOAuthClient implements GithubOAuthClient {
  deviceCodeRequests = 0;
  /** Wall-clock ms of every pollDeviceToken call that reached the fake. */
  readonly pollTimes: number[] = [];
  intervalMs: number;
  expiresInMs: number;
  accessTtlMs = 3_600_000;
  login = "octocat";

  private authorized = false;
  private denied = false;
  private issued = 0;
  private readonly scriptedPolls: GithubPollOutcome[] = [];

  constructor(options?: { intervalMs?: number; expiresInMs?: number }) {
    this.intervalMs = options?.intervalMs ?? 5_000;
    this.expiresInMs = options?.expiresInMs ?? 900_000;
  }

  /** The user finished the verification-page ceremony. */
  authorize(): void {
    this.authorized = true;
    this.denied = false;
  }

  /** The user rejected the authorization request. */
  deny(): void {
    this.denied = true;
  }

  /** Queue poll outcomes consumed before the authorize/deny state applies. */
  pushPoll(...outcomes: GithubPollOutcome[]): void {
    this.scriptedPolls.push(...outcomes);
  }

  private rotateCredential(task: SimulationTask): StoredCredential {
    this.issued += 1;
    return {
      access: `gh-access-${this.issued}`,
      refresh: `gh-refresh-${this.issued}`,
      accountId: this.login,
      expiresAt: task.wallNow() + this.accessTtlMs,
    };
  }

  requestDeviceCode(
    task: SimulationTask,
  ): ResultAsync<GithubDeviceGrant, GithubOAuthTransientError> {
    const run = async (): Promise<GithubDeviceGrant> => {
      await task.sleep(1 + task.random("github device latency") * 20, "github device code");
      await task.failpoint(FAILPOINTS.githubDeviceCode, "github device code");
      this.deviceCodeRequests += 1;
      return {
        deviceCode: `device-${this.deviceCodeRequests}`,
        userCode: `CODE-${this.deviceCodeRequests}`,
        verificationUri: "https://github.test/login/device",
        intervalMs: this.intervalMs,
        expiresAt: task.wallNow() + this.expiresInMs,
      };
    };
    return ResultAsync.fromPromise(run(), (error) => {
      if (error instanceof ApplicationFailure) return transient(error.message);
      return task.abortSimulation(error);
    });
  }

  pollDeviceToken(
    task: SimulationTask,
    _deviceCode: string,
  ): ResultAsync<GithubPollOutcome, GithubOAuthTransientError> {
    const run = async (): Promise<GithubPollOutcome> => {
      await task.sleep(1 + task.random("github poll latency") * 20, "github device poll");
      await task.failpoint(FAILPOINTS.githubDevicePoll, "github device poll");
      this.pollTimes.push(task.wallNow());
      const scripted = this.scriptedPolls.shift();
      if (scripted !== undefined) return scripted;
      if (this.denied) return { kind: "denied" };
      if (this.authorized) {
        return { kind: "authorized", credential: this.rotateCredential(task) };
      }
      return { kind: "pending" };
    };
    return ResultAsync.fromPromise(run(), (error) => {
      if (error instanceof ApplicationFailure) return transient(error.message);
      return task.abortSimulation(error);
    });
  }
}

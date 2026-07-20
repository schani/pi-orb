import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { SimulationTask } from "determined";
import { ResultAsync } from "neverthrow";
import type { AuthGateError } from "../../domain/errors.ts";
import type { AuthGate, AuthResolution, DeviceChallenge } from "../../domain/ports.ts";

const PROVIDER = "openai-codex";

interface ActiveFlow {
  challenge: DeviceChallenge | null;
  challengeWaiters: ((challenge: DeviceChallenge) => void)[];
  state: "pending" | "succeeded" | "failed";
  failureMessage: string;
}

/**
 * Codex auth gate over Pi's ModelRuntime (DESIGN.md §15.1). Auth resolves
 * through the shared auth.json under Pi's credential-store lock; a missing or
 * unrefreshable credential starts exactly one global headless device-code
 * flow whose public challenge is shared by every blocked orb. No secret ever
 * leaves this adapter.
 */
export class PiAuthGate implements AuthGate {
  private readonly authDir: string;
  private runtime: ModelRuntime | null = null;
  private flow: ActiveFlow | null = null;

  constructor(authDir: string) {
    this.authDir = authDir;
  }

  private async getRuntime(): Promise<ModelRuntime> {
    if (this.runtime === null) {
      this.runtime = await ModelRuntime.create({
        authPath: join(this.authDir, "auth.json"),
        modelsPath: null,
      });
    }
    return this.runtime;
  }

  private startFlow(runtime: ModelRuntime, wallNow: number): ActiveFlow {
    const flow: ActiveFlow = {
      challenge: null,
      challengeWaiters: [],
      state: "pending",
      failureMessage: "",
    };
    void runtime
      .login(PROVIDER, "oauth", {
        prompt: (prompt) => {
          if (prompt.type === "select") {
            const device = prompt.options.find((option) => option.id === "device_code");
            if (device !== undefined) return Promise.resolve(device.id);
          }
          return Promise.reject(new Error(`unsupported auth prompt: ${prompt.type}`));
        },
        notify: (event) => {
          if (event.type === "device_code") {
            const challenge: DeviceChallenge = {
              verificationUri: event.verificationUri,
              userCode: event.userCode,
              expiresAt: wallNow + (event.expiresInSeconds ?? 900) * 1000,
            };
            flow.challenge = challenge;
            for (const waiter of flow.challengeWaiters) waiter(challenge);
            flow.challengeWaiters.length = 0;
          }
        },
      })
      .then(
        () => {
          flow.state = "succeeded";
        },
        (error: unknown) => {
          flow.state = "failed";
          flow.failureMessage = error instanceof Error ? error.message : String(error);
        },
      );
    return flow;
  }

  private awaitChallenge(flow: ActiveFlow, timeoutMs: number): Promise<DeviceChallenge | null> {
    if (flow.challenge !== null) return Promise.resolve(flow.challenge);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(flow.challenge), timeoutMs);
      flow.challengeWaiters.push((challenge) => {
        clearTimeout(timer);
        resolve(challenge);
      });
    });
  }

  ensureAuth(task: SimulationTask): ResultAsync<AuthResolution, AuthGateError> {
    const run = async (): Promise<AuthResolution> => {
      const runtime = await this.getRuntime();
      const flow = this.flow;
      if (flow !== null) {
        if (flow.state === "succeeded") {
          this.flow = null;
          return { status: "ok" };
        }
        if (flow.state === "failed") {
          // Report once; a later start request may initiate a new flow.
          this.flow = null;
          return { status: "failed", message: flow.failureMessage, retryable: true };
        }
        const challenge = await this.awaitChallenge(flow, 10_000);
        if (challenge !== null) return { status: "pending", challenge };
        return {
          status: "pending",
          challenge: {
            verificationUri: "",
            userCode: "",
            expiresAt: task.wallNow(),
          },
        };
      }
      const auth = await runtime.getAuth(PROVIDER);
      if (auth !== undefined) return { status: "ok" };
      const started = this.startFlow(runtime, task.wallNow());
      this.flow = started;
      const challenge = await this.awaitChallenge(started, 10_000);
      if (challenge !== null) return { status: "pending", challenge };
      if (started.state === "failed") {
        this.flow = null;
        return { status: "failed", message: started.failureMessage, retryable: true };
      }
      return {
        status: "pending",
        challenge: {
          verificationUri: "",
          userCode: "",
          expiresAt: task.wallNow(),
        },
      };
    };
    return ResultAsync.fromPromise(run(), (error): AuthGateError => ({
      type: "auth_gate_error",
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
    }));
  }
}

import { join } from "node:path";
import { ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { type MockOpenAiConfig, mockOpenAiProviderConfig } from "@pi-orb/mock-openai";
import type { SimulationTask } from "determined";
import { Result, ResultAsync } from "neverthrow";
import { commitLoginCredential } from "../../domain/broker.ts";
import type { AuthGateError } from "../../domain/errors.ts";
import type {
  AuthGate,
  AuthResolution,
  BrokerDeps,
  DeviceChallenge,
  StoredCredential,
} from "../../domain/ports.ts";

const PROVIDER = "openai-codex";

/** Extract the ChatGPT account id from the access token's JWT claims. */
const accountIdFromAccessToken = Result.fromThrowable(
  (access: string): string => {
    const payload = access.split(".")[1] ?? "";
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const auth = claims["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
    const accountId = auth?.["chatgpt_account_id"];
    if (typeof accountId !== "string") return "unknown";
    return accountId;
  },
  () => "unknown" as const,
);

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
  private readonly mockOpenAi: MockOpenAiConfig | null;
  private readonly broker: BrokerDeps | null;
  private runtime: ModelRuntime | null = null;
  private flow: ActiveFlow | null = null;

  constructor(
    authDir: string,
    mockOpenAi: MockOpenAiConfig | null = null,
    broker: BrokerDeps | null = null,
  ) {
    this.authDir = authDir;
    this.mockOpenAi = mockOpenAi;
    this.broker = broker;
  }

  /**
   * Make sure the broker's pointer/secret pair holds the credential Pi's
   * auth.json holds (DESIGN.md §15.1): after a fresh login, and on first boot
   * over a pre-broker auth.json. Idempotent via the pointer check; login
   * races resolve through the fenced commit inside the broker.
   */
  private async seedBroker(
    task: SimulationTask,
    force: boolean,
  ): Promise<{ ok: boolean; message: string }> {
    if (this.broker === null) return { ok: true, message: "" };
    if (!force) {
      const pointer = await this.broker.pointers.readPointer(task, PROVIDER);
      if (pointer.isErr()) return { ok: false, message: pointer.error.message };
      if (pointer.value?.secretVersion != null) return { ok: true, message: "" };
    }
    // The raw credential (with the refresh token) comes from auth.json via
    // Pi's storage reader; `getAuth` only returns resolved request auth.
    const stored = Result.fromThrowable(
      () => readStoredCredential(PROVIDER, join(this.authDir, "auth.json")),
      (error) => (error instanceof Error ? error.message : String(error)),
    )();
    if (stored.isErr()) return { ok: false, message: stored.error };
    const raw = stored.value;
    if (raw === undefined || raw.type !== "oauth") {
      return { ok: false, message: "no OAuth credential to seed the broker with" };
    }
    const credential: StoredCredential = {
      access: raw.access,
      refresh: raw.refresh,
      accountId: accountIdFromAccessToken(raw.access).unwrapOr("unknown"),
      expiresAt: typeof raw.expires === "number" ? raw.expires : task.wallNow() + 3_600_000,
    };
    const committed = await commitLoginCredential(task, this.broker, PROVIDER, credential);
    if (committed.isErr()) return { ok: false, message: committed.error.message };
    return { ok: true, message: "" };
  }

  private async getRuntime(): Promise<ModelRuntime> {
    if (this.runtime === null) {
      const runtime = await ModelRuntime.create({
        authPath: join(this.authDir, "auth.json"),
        modelsPath: null,
        // The control plane resolves auth only; it never needs the live model
        // catalog. Without this, `ModelRuntime.login` ends with a network
        // availability sweep across every provider, which can stall the
        // device flow for minutes.
        allowModelNetwork: false,
      });
      if (this.mockOpenAi !== null) {
        // E2E mode: OAuth and inference go to the fake OpenAI service
        // through the supported provider override (PI-CODEX-E2E.md).
        runtime.registerProvider(PROVIDER, mockOpenAiProviderConfig(this.mockOpenAi));
      }
      this.runtime = runtime;
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
          // A fresh login always overwrites the broker credential: the
          // pointer may still hold a stale (revoked) one.
          const seeded = await this.seedBroker(task, true);
          if (!seeded.ok) {
            return { status: "failed", message: seeded.message, retryable: true };
          }
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
      if (auth !== undefined) {
        // Bridge a pre-broker auth.json into the broker on first sight.
        const seeded = await this.seedBroker(task, false);
        if (!seeded.ok) return { status: "failed", message: seeded.message, retryable: true };
        return { status: "ok" };
      }
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

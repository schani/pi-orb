import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  CredentialSynchronizationError,
  ModelRuntime,
  readStoredCredential,
} from "@earendil-works/pi-coding-agent";
import { type MockOpenAiConfig, mockOpenAiProviderConfig } from "@pi-orb/mock-openai";
import type { SimulationTask } from "determined";
import { err, ok, Result, ResultAsync } from "neverthrow";
import { commitLoginCredential, getToken } from "../../domain/broker.ts";
import type { AuthGateError } from "../../domain/errors.ts";
import type {
  AuthGate,
  AuthResolution,
  BrokerDeps,
  DeviceChallenge,
  StoredCredential,
} from "../../domain/ports.ts";

const PROVIDER = "openai-codex";

const accountIdFromAccessToken = Result.fromThrowable(
  (access: string): string => {
    const payload = access.split(".")[1] ?? "";
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const auth = claims["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
    const accountId = auth?.["chatgpt_account_id"];
    return typeof accountId === "string" ? accountId : "unknown";
  },
  () => "unknown" as const,
);

interface ActiveFlow {
  challenge: DeviceChallenge | null;
  state: "pending" | "succeeded" | "failed";
}

/** Per-user Codex device-login adapter. The broker is the only credential authority. */
export class PiAuthGate implements AuthGate {
  private readonly flows = new Map<string, ActiveFlow>();
  private readonly authDir: string;
  private readonly mockOpenAiForUser: (userId: string) => MockOpenAiConfig | null;
  private readonly brokerForUser: (userId: string) => BrokerDeps;
  private readonly runtimeFactory: (authPath: string) => Promise<ModelRuntime>;
  private readonly readCredential: typeof readStoredCredential;

  constructor(
    authDir: string,
    mockOpenAi: MockOpenAiConfig | null | ((userId: string) => MockOpenAiConfig | null),
    brokerForUser: (userId: string) => BrokerDeps,
    runtimeFactory: (authPath: string) => Promise<ModelRuntime> = async (authPath) => {
      await mkdir(dirname(authPath), { recursive: true, mode: 0o700 });
      return ModelRuntime.create({ authPath, modelsPath: null, allowModelNetwork: false });
    },
    readCredential: typeof readStoredCredential = readStoredCredential,
  ) {
    this.authDir = authDir;
    this.mockOpenAiForUser = typeof mockOpenAi === "function" ? mockOpenAi : () => mockOpenAi;
    this.brokerForUser = brokerForUser;
    this.runtimeFactory = runtimeFactory;
    this.readCredential = readCredential;
  }

  private authPath(userId: string): string {
    return join(this.authDir, "users", userId, "auth.json");
  }

  private async publishLogin(
    task: SimulationTask,
    userId: string,
  ): Promise<Result<AuthResolution, AuthGateError>> {
    const stored = Result.fromThrowable(
      () => this.readCredential(PROVIDER, this.authPath(userId)),
      (): AuthGateError => ({
        type: "auth_gate_error",
        message: "failed to read completed Codex login",
        retryable: true,
      }),
    )();
    if (stored.isErr()) return err(stored.error);
    const raw = stored.value;
    if (raw === undefined || raw.type !== "oauth") {
      return err({
        type: "auth_gate_error",
        message: "completed login did not persist OAuth",
        retryable: true,
      });
    }
    const credential: StoredCredential = {
      access: raw.access,
      refresh: raw.refresh,
      accountId: accountIdFromAccessToken(raw.access).unwrapOr("unknown"),
      expiresAt: typeof raw.expires === "number" ? raw.expires : task.wallNow() + 3_600_000,
    };
    const committed = await commitLoginCredential(
      task,
      this.brokerForUser(userId),
      PROVIDER,
      credential,
    );
    if (committed.isErr()) {
      if (committed.error.type === "login_commit_uncertain") this.flows.delete(userId);
      return err({
        type: "auth_gate_error",
        message: "failed to publish completed Codex login",
        retryable: true,
      });
    }
    this.flows.delete(userId);
    return ok({ status: "ok" });
  }

  private async createRuntime(userId: string): Promise<ModelRuntime> {
    const runtime = await this.runtimeFactory(this.authPath(userId));
    const mockOpenAi = this.mockOpenAiForUser(userId);
    if (mockOpenAi !== null) {
      runtime.registerProvider(PROVIDER, mockOpenAiProviderConfig(mockOpenAi));
    }
    return runtime;
  }

  private startFlow(runtime: ModelRuntime, wallNow: number): ActiveFlow {
    const flow: ActiveFlow = { challenge: null, state: "pending" };
    const login = Result.fromThrowable(
      () =>
        runtime.login(PROVIDER, "oauth", {
          prompt: (prompt) => {
            if (prompt.type === "select") {
              const device = prompt.options.find((option) => option.id === "device_code");
              if (device !== undefined) return Promise.resolve(device.id);
            }
            return Promise.reject(new Error("unsupported Codex authentication prompt"));
          },
          notify: (event) => {
            if (event.type !== "device_code") return;
            const challenge: DeviceChallenge = {
              provider: "openai-codex",
              verificationUri: event.verificationUri,
              userCode: event.userCode,
              expiresAt: wallNow + (event.expiresInSeconds ?? 900) * 1000,
            };
            flow.challenge = challenge;
          },
        }),
      () => undefined,
    )();
    if (login.isErr()) {
      flow.state = "failed";
      return flow;
    }
    void login.value.then(
      () => {
        flow.state = "succeeded";
      },
      (error: unknown) => {
        // Pi documents only this rejection as a completed credential
        // mutation. Other SDK rejections have no typed denial/expiry
        // distinction, so conservatively retry them without failing orbs.
        if (
          error instanceof CredentialSynchronizationError &&
          error.providerId === PROVIDER &&
          error.operation === "login"
        ) {
          flow.state = "succeeded";
          return;
        }
        flow.state = "failed";
      },
    );
    return flow;
  }

  ensureAuth(task: SimulationTask, userId: string): ResultAsync<AuthResolution, AuthGateError> {
    const run = async (): Promise<Result<AuthResolution, AuthGateError>> => {
      const broker = this.brokerForUser(userId);
      const flow = this.flows.get(userId);
      const canonical = await getToken(task, broker, PROVIDER, { reason: "startup" });
      if (canonical.isOk()) {
        if (flow !== undefined && flow.state !== "pending") this.flows.delete(userId);
        return ok({ status: "ok" });
      }
      if (canonical.error.type !== "auth_required") {
        return err({
          type: "auth_gate_error",
          message: "failed to resolve Codex credential",
          retryable: true,
        });
      }

      let active = flow;
      if (active === undefined) {
        const runtime = await ResultAsync.fromPromise(
          this.createRuntime(userId),
          (): AuthGateError => ({
            type: "auth_gate_error",
            message: "failed to initialize Codex login",
            retryable: true,
          }),
        );
        if (runtime.isErr()) return err(runtime.error);
        active = this.startFlow(runtime.value, task.wallNow());
        this.flows.set(userId, active);
      }

      if (active.state === "succeeded") return this.publishLogin(task, userId);
      if (active.state === "failed") {
        this.flows.delete(userId);
        if (active.challenge !== null && task.wallNow() >= active.challenge.expiresAt) {
          return ok({ status: "failed", message: "Codex device code expired", retryable: false });
        }
        return err({
          type: "auth_gate_error",
          message: "Codex login failed temporarily",
          retryable: true,
        });
      }
      return ok({
        status: "pending",
        challenge: active.challenge ?? {
          provider: "openai-codex",
          verificationUri: "",
          userCode: "",
          expiresAt: task.wallNow(),
        },
      });
    };
    return ResultAsync.fromPromise(
      run(),
      (): AuthGateError => ({
        type: "auth_gate_error",
        message: "Codex authentication adapter failed",
        retryable: true,
      }),
    ).andThen((result) => result);
  }
}

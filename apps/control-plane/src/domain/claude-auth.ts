import type { ClaudeAuthView, ClaudeSubscriptionGrant } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, errAsync, ok, okAsync, type Result, ResultAsync } from "neverthrow";
import type { AuthGateError } from "./errors.ts";
import { logEvent } from "./log.ts";
import type {
  AuthGate,
  AuthResolution,
  CredentialPointerStoreFactory,
  CredentialSecretStore,
  StoredClaudeSubscriptionCredential,
} from "./ports.ts";

export const CLAUDE_SUBSCRIPTION_PROVIDER = "claude-subscription";
export interface ClaudeAuthError {
  readonly code: "unavailable" | "conflict" | "invalid_request";
  readonly message: string;
  readonly stage?: "exit" | "cleanup";
}
export interface ClaudeAuthSession {
  sendCode(code: string): Result<void, ClaudeAuthError>;
  /** Requests termination; drain proves completion. */
  cancel(): Result<void, ClaudeAuthError>;
  /** Success proves native exit and scratch removal. */
  drain(): ResultAsync<void, ClaudeAuthError>;
}
export type ClaudeAuthEvent =
  | { readonly challenge: NonNullable<ClaudeAuthView["challenge"]> }
  | { readonly token: string }
  | { readonly progress: "input_completed" }
  | {
      readonly error: string;
      readonly stage?:
        | "transport"
        | "timeout"
        | "parser"
        | "cleanup"
        | "exit"
        | "native_input"
        | "native_exchange";
      readonly reason?: "network" | "code_rejected" | "authentication";
    };
export interface ClaudeAuthTransport {
  /** An error without stage guarantees no undrained helper remains. */
  start(emit: (event: ClaudeAuthEvent) => void): ResultAsync<ClaudeAuthSession, ClaudeAuthError>;
}
interface Flow {
  view: ClaudeAuthView;
  session?: ClaudeAuthSession;
  ready: Promise<void>;
  stopping?: ResultAsync<void, ClaudeAuthError>;
  cancelAccepted?: boolean;
  acquisitionError?: ClaudeAuthError;
  publication?: Promise<void>;
  cancelled: boolean;
  codeAccepted: boolean;
  inputCompleted: boolean;
  expectedVersion: number | null;
  previousSecretVersion: string | null;
  generation: number;
}
const unavailable = (): ClaudeAuthError => ({
  code: "unavailable",
  message: "Claude credential storage unavailable",
});

export class ClaudeSubscriptionAuth {
  private readonly flows = new Map<string, Flow>();
  private closed = false;
  private readonly pointers: CredentialPointerStoreFactory;
  private readonly secrets: CredentialSecretStore;
  private readonly transport: ClaudeAuthTransport;
  constructor(
    pointers: CredentialPointerStoreFactory,
    secrets: CredentialSecretStore,
    transport: ClaudeAuthTransport,
  ) {
    this.pointers = pointers;
    this.secrets = secrets;
    this.transport = transport;
  }
  close(task: SimulationTask): ResultAsync<void, ClaudeAuthError> {
    this.closed = true;
    for (const flow of this.flows.values()) flow.cancelled = true;
    return new ResultAsync(
      (async () => {
        const results = await Promise.all(
          [...this.flows].map(async ([userId, flow]) => {
            const result = await this.stop(task, userId, flow);
            logEvent(task, "claude-auth-shutdown", {
              user: userId,
              cancelAccepted: flow.cancelAccepted ?? null,
              drained: result.isOk(),
              stage: result.isErr() ? result.error.stage : undefined,
            });
            return result;
          }),
        );
        const failed = results.find((result) => result.isErr());
        return failed?.isErr() ? err(failed.error) : ok(undefined);
      })(),
    );
  }
  private stop(
    task: SimulationTask,
    userId: string,
    flow: Flow,
  ): ResultAsync<void, ClaudeAuthError> {
    flow.cancelled = true;
    if (flow.view.status === "connecting") flow.view = { status: "connecting" };
    if (flow.stopping) return flow.stopping;
    flow.stopping = new ResultAsync(
      (async (): Promise<Result<void, ClaudeAuthError>> => {
        await flow.ready;
        const cancelled = flow.session?.cancel();
        if (cancelled) flow.cancelAccepted = cancelled.isOk();
        logEvent(task, "claude-auth-cancel-requested", {
          user: userId,
          cancelAccepted: flow.cancelAccepted ?? null,
        });
        const drained = flow.session
          ? await flow.session.drain()
          : flow.acquisitionError
            ? err(flow.acquisitionError)
            : ok(undefined);
        await flow.publication;
        logEvent(task, "claude-auth-drained", {
          user: userId,
          drained: drained.isOk(),
          exitObserved: flow.session ? drained.isOk() || drained.error.stage === "cleanup" : null,
          scratchRemoved: flow.session ? drained.isOk() : null,
          stage: drained.isErr() ? drained.error.stage : undefined,
        });
        if (drained.isErr()) {
          flow.view = {
            status: "failed",
            error: "Claude sign-in cleanup could not be confirmed; reconnect",
          };
          return err(drained.error);
        }
        return ok(undefined);
      })(),
    );
    return flow.stopping;
  }
  grantForOrb(
    task: SimulationTask,
    store: import("./ports.ts").ControlPlaneStore,
    orb: import("./orb.ts").OrbRow,
  ): ResultAsync<ClaudeSubscriptionGrant | null, ClaudeAuthError> {
    if (orb.harness !== "claude")
      return new ResultAsync(
        Promise.resolve(err({ code: "invalid_request", message: "Claude harness required" })),
      );
    return store
      .getProject(task, orb.projectId)
      .mapErr(unavailable)
      .andThen((project) =>
        project === null ? err(unavailable()) : this.grant(task, project.ownerUserId),
      );
  }
  grant(
    task: SimulationTask,
    userId: string,
  ): ResultAsync<ClaudeSubscriptionGrant | null, ClaudeAuthError> {
    return this.pointers
      .forUser(userId)
      .readPointer(task, CLAUDE_SUBSCRIPTION_PROVIDER)
      .mapErr(unavailable)
      .andThen((row) => {
        if (row?.secretVersion == null) return ok(null);
        return this.secrets
          .readSecret<StoredClaudeSubscriptionCredential>(
            task,
            CLAUDE_SUBSCRIPTION_PROVIDER,
            row.secretVersion,
          )
          .mapErr(unavailable)
          .andThen((secret) =>
            secret?.kind === "claude_subscription"
              ? ok({ token: secret.token, generation: row.generation })
              : err(unavailable()),
          );
      });
  }
  status(task: SimulationTask, userId: string): ResultAsync<ClaudeAuthView, ClaudeAuthError> {
    return ResultAsync.fromSafePromise(this.flows.get(userId)?.publication ?? Promise.resolve())
      .andThen(() => this.grant(task, userId))
      .map((grant) => {
        const flow = this.flows.get(userId);
        if (flow?.view.status === "connecting" || flow?.view.status === "failed") return flow.view;
        return grant !== null
          ? { status: "connected", generation: grant.generation }
          : { status: "disconnected" };
      });
  }
  connect(task: SimulationTask, userId: string): ResultAsync<ClaudeAuthView, ClaudeAuthError> {
    if (this.closed)
      return errAsync({ code: "unavailable", message: "Claude sign-in unavailable" });
    const active = this.flows.get(userId);
    if (active?.view.status === "connecting" && !active.cancelled) return this.status(task, userId);
    const priorDrain = active ? this.stop(task, userId, active) : okAsync(undefined);
    let ready!: () => void;
    // Claim before any persistence/transport await so concurrent clicks cannot start two ceremonies.
    const flow: Flow = {
      view: { status: "connecting" },
      ready: new Promise<void>((resolve) => {
        ready = resolve;
      }),
      cancelled: false,
      codeAccepted: false,
      inputCompleted: false,
      expectedVersion: null,
      previousSecretVersion: null,
      generation: 1,
    };
    this.flows.set(userId, flow);
    logEvent(task, "claude-auth-started", { user: userId });
    return priorDrain
      .andThen(() =>
        this.pointers
          .forUser(userId)
          .readPointer(task, CLAUDE_SUBSCRIPTION_PROVIDER)
          .mapErr(unavailable),
      )
      .andThen((row) => {
        flow.expectedVersion = row?.rowVersion ?? null;
        flow.previousSecretVersion = row?.secretVersion ?? null;
        flow.generation = (row?.generation ?? 0) + 1;
        if (flow.cancelled) return ok(flow.view);
        return this.transport
          .start((event) => {
            if ("error" in event && event.stage === "cleanup")
              logEvent(task, "claude-auth-cleanup-failed", { user: userId });
            if (flow.cancelled || this.flows.get(userId) !== flow) return;
            if ("progress" in event) {
              flow.inputCompleted = true;
              logEvent(task, "claude-auth-input-completed", { user: userId });
            } else if ("challenge" in event) {
              if (!flow.codeAccepted)
                flow.view = { status: "connecting", challenge: event.challenge };
            } else if ("error" in event) {
              logEvent(task, "claude-auth-failed", {
                user: userId,
                stage: event.stage ?? "transport",
                reason: event.reason,
                codeAccepted: flow.codeAccepted,
                inputCompleted: flow.inputCompleted,
              });
              flow.view = { status: "failed", error: "Claude sign-in failed; reconnect" };
            } else if (!flow.publication)
              flow.publication = this.publish(task, userId, flow, event.token);
          })
          .map((session) => {
            flow.session = session;
            return flow.view;
          });
      })
      .map((view) => {
        ready();
        return view;
      })
      .mapErr((error) => {
        if (error.stage) flow.acquisitionError = error;
        ready();
        logEvent(task, "claude-auth-failed", { user: userId, stage: "transport" });
        flow.view = { status: "failed", error: "Claude sign-in unavailable" };
        return error;
      });
  }
  private async publish(
    task: SimulationTask,
    userId: string,
    flow: Flow,
    token: string,
  ): Promise<void> {
    const written = await this.secrets.writeSecret<StoredClaudeSubscriptionCredential>(
      task,
      CLAUDE_SUBSCRIPTION_PROVIDER,
      { kind: "claude_subscription", token, createdAt: task.wallNow() },
    );
    if (written.isErr()) {
      logEvent(task, "claude-auth-publication-failed", { user: userId, stage: "secret" });
      flow.view = { status: "failed", error: "Claude credential publication failed; reconnect" };
      return;
    }
    if (flow.cancelled) {
      await this.secrets.destroySecret(task, CLAUDE_SUBSCRIPTION_PROVIDER, written.value.version);
      return;
    }
    const pointer = this.pointers.forUser(userId);
    const committed = await pointer.casWritePointer(
      task,
      CLAUDE_SUBSCRIPTION_PROVIDER,
      flow.expectedVersion,
      {
        generation: flow.generation,
        secretVersion: written.value.version,
        refreshLeaseUntil: 0,
        lastRefreshAt: 0,
      },
    );
    if (committed.isOk()) {
      await this.finishPublication(
        task,
        userId,
        flow,
        written.value.version,
        committed.value.rowVersion,
      );
      return;
    }
    // A failed write can have committed. Never destroy a potentially published version.
    const observed = await pointer.readPointer(task, CLAUDE_SUBSCRIPTION_PROVIDER);
    if (observed.isOk() && observed.value?.secretVersion === written.value.version) {
      logEvent(task, "claude-auth-publication-adopted", {
        user: userId,
        generation: flow.generation,
      });
      await this.finishPublication(
        task,
        userId,
        flow,
        written.value.version,
        observed.value.rowVersion,
      );
      return;
    }
    if (observed.isOk())
      await this.secrets.destroySecret(task, CLAUDE_SUBSCRIPTION_PROVIDER, written.value.version);
    logEvent(task, "claude-auth-publication-failed", { user: userId, stage: "pointer" });
    flow.view = { status: "failed", error: "Claude credential publication failed; reconnect" };
  }
  private async finishPublication(
    task: SimulationTask,
    userId: string,
    flow: Flow,
    version: string,
    rowVersion: number,
  ): Promise<void> {
    if (!flow.cancelled) {
      flow.view = { status: "connected", generation: flow.generation };
      logEvent(task, "claude-auth-published", { user: userId, generation: flow.generation });
      if (flow.previousSecretVersion !== null)
        await this.secrets.destroySecret(
          task,
          CLAUDE_SUBSCRIPTION_PROVIDER,
          flow.previousSecretVersion,
        );
      return;
    }
    const pointer = this.pointers.forUser(userId);
    const cleared = await pointer.casWritePointer(task, CLAUDE_SUBSCRIPTION_PROVIDER, rowVersion, {
      generation: flow.generation + 1,
      secretVersion: flow.previousSecretVersion,
      refreshLeaseUntil: 0,
      lastRefreshAt: 0,
    });
    const observed = await pointer.readPointer(task, CLAUDE_SUBSCRIPTION_PROVIDER);
    if (observed.isErr() || observed.value?.secretVersion === version) {
      logEvent(task, "claude-auth-cancel-unconfirmed", { user: userId });
      flow.view = {
        status: "failed",
        error: "Claude sign-in cancellation could not be confirmed; disconnect",
      };
      return;
    }
    logEvent(task, "claude-auth-cancelled", { user: userId, ambiguous: cleared.isErr() });
    flow.view = { status: "disconnected" };
    await this.secrets.destroySecret(task, CLAUDE_SUBSCRIPTION_PROVIDER, version);
  }
  code(
    task: SimulationTask,
    userId: string,
    code: string,
  ): ResultAsync<ClaudeAuthView, ClaudeAuthError> {
    const flow = this.flows.get(userId);
    if (
      this.closed ||
      !flow?.session ||
      flow.cancelled ||
      flow.view.status !== "connecting" ||
      flow.codeAccepted ||
      code.length < 1 ||
      code.length > 4096 ||
      [...code].some((char) => char.charCodeAt(0) < 32)
    )
      return new ResultAsync(
        Promise.resolve(
          err({ code: "invalid_request", message: "Claude sign-in code not accepted" }),
        ),
      );
    const sent = flow.session.sendCode(code);
    if (sent.isErr()) {
      logEvent(task, "claude-auth-failed", {
        user: userId,
        stage: "native_input",
        codeAccepted: false,
      });
      flow.view = { status: "failed", error: "Claude sign-in input failed; reconnect" };
      return new ResultAsync(Promise.resolve(err(sent.error)));
    }
    flow.codeAccepted = true;
    flow.view = { status: "connecting" };
    logEvent(task, "claude-auth-code-accepted", { user: userId });
    return this.status(task, userId);
  }
  cancel(task: SimulationTask, userId: string): ResultAsync<ClaudeAuthView, ClaudeAuthError> {
    const flow = this.flows.get(userId);
    if (!flow) return this.status(task, userId);
    return this.stop(task, userId, flow).andThen(() => {
      if (flow.view.status !== "failed") flow.view = { status: "disconnected" };
      return this.status(task, userId);
    });
  }
  disconnect(task: SimulationTask, userId: string): ResultAsync<ClaudeAuthView, ClaudeAuthError> {
    const pointer = this.pointers.forUser(userId);
    return this.cancel(task, userId)
      .andThen(() => pointer.readPointer(task, CLAUDE_SUBSCRIPTION_PROVIDER).mapErr(unavailable))
      .andThen((row) => {
        if (row === null) return ok({ status: "disconnected" } as ClaudeAuthView);
        return new ResultAsync(
          (async (): Promise<Result<ClaudeAuthView, ClaudeAuthError>> => {
            const cleared = await pointer.casWritePointer(
              task,
              CLAUDE_SUBSCRIPTION_PROVIDER,
              row.rowVersion,
              {
                generation: row.generation + 1,
                secretVersion: null,
                refreshLeaseUntil: 0,
                lastRefreshAt: 0,
              },
            );
            const observed = await pointer.readPointer(task, CLAUDE_SUBSCRIPTION_PROVIDER);
            if (observed.isErr() || observed.value?.secretVersion != null) {
              logEvent(task, "claude-auth-disconnect-unconfirmed", { user: userId });
              return err(unavailable());
            }
            if (row.secretVersion !== null)
              await this.secrets.destroySecret(
                task,
                CLAUDE_SUBSCRIPTION_PROVIDER,
                row.secretVersion,
              );
            logEvent(task, "claude-auth-disconnected", {
              user: userId,
              ambiguous: cleared.isErr(),
            });
            const flow = this.flows.get(userId);
            if (flow?.cancelled) flow.view = { status: "disconnected" };
            return ok({ status: "disconnected" });
          })(),
        );
      });
  }
}
export class ClaudeAuthGate implements AuthGate {
  private readonly auth: ClaudeSubscriptionAuth;
  constructor(auth: ClaudeSubscriptionAuth) {
    this.auth = auth;
  }
  ensureAuth(task: SimulationTask, userId: string): ResultAsync<AuthResolution, AuthGateError> {
    return this.auth
      .grant(task, userId)
      .mapErr(
        (): AuthGateError => ({
          type: "auth_gate_error",
          message: "Claude credential unavailable",
          retryable: true,
        }),
      )
      .map((grant) =>
        grant !== null
          ? { status: "ok" }
          : {
              status: "pending",
              challenge: {
                provider: "claude",
                verificationUri: "",
                userCode: "",
                expiresAt: task.wallNow() + 600_000,
              },
            },
      );
  }
}

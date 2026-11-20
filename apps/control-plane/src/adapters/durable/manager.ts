import type { Context } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { RuntimeHealth } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, errAsync, ok, okAsync, type Result, ResultAsync } from "neverthrow";
import type { AgentAlertWriter, AgentPlane, AgentSessionFacade } from "../../domain/agent-ports.ts";
import type { RuntimeClientError } from "../../domain/errors.ts";
import { logOrbEvent } from "../../domain/log.ts";
import type { OrbRow } from "../../domain/orb.ts";
import type { OrbAgentError } from "../../domain/orb-agent-operations.ts";
import type {
  DeliverMessageClientRequest,
  OperationContext,
  PullHistoryClientRequest,
} from "../../domain/ports.ts";
import { DurableAgent, type DurableAgentOptions } from "./agent.ts";
import { StableAgentHandle } from "./handle.ts";
import type { AgentPersistence, AgentStorageLease } from "./persistence.ts";

export function durableError(message: string, retryable = false): RuntimeClientError {
  return {
    type: "runtime_client_error",
    code: "history_unavailable",
    answered: true,
    message,
    retryable,
  };
}

export interface AgentOwnership<T> {
  open(orbId: string, admissionVersion: number): ResultAsync<T, RuntimeClientError>;
  close(agent: T): ResultAsync<void, RuntimeClientError>;
  revoke?(agent: T): void;
  active?(agent: T): boolean;
}

type Revocation = "superseded" | "suspend" | "dispose" | "shutdown";

type Owned<T> = { state: "owned"; admissionVersion: number; agent: T };
type AgentOwner<T> =
  | Owned<T>
  | {
      state: "retiring";
      admissionVersion: number;
      closed: ResultAsync<void, RuntimeClientError>;
      refusal: RuntimeClientError | undefined;
    };

export type StartupFailure =
  | RuntimeClientError
  | {
      type: "startup_cleanup_failed";
      cleanupError: RuntimeClientError;
      refusal: RuntimeClientError | undefined;
    };

export function definitiveStartupRefusal(error?: RuntimeClientError) {
  return error?.code === "legacy_backend" || error?.code === "history_integrity"
    ? error
    : undefined;
}

export function startupCleanupFailure(
  cleanupError: RuntimeClientError,
  error?: RuntimeClientError,
) {
  return {
    type: "startup_cleanup_failed" as const,
    cleanupError,
    refusal: definitiveStartupRefusal(error),
  };
}

type Publish<T> = (agent: T, openSignal?: AbortSignal) => Result<void, RuntimeClientError>;
type Open<T> = (signal: AbortSignal, publish: Publish<T>) => ResultAsync<T, StartupFailure>;

function startupError(error: RuntimeClientError, signal: AbortSignal): RuntimeClientError {
  return signal.aborted && error.code === "cancelled" ? cancelledOpen() : error;
}

/** One mutation line per orb; shutdown joins every previously admitted open. */
export class OrbAgentManager<T> {
  private readonly agents = new Map<string, AgentOwner<T>>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly disposed = new Set<string>();
  private readonly suspended = new Map<string, boolean>();
  private readonly admissions = new Map<string, number>();
  private readonly tickets = new Map<string, number>();
  private readonly opening = new Map<string, AbortController>();
  private closing = false;
  private readonly ownership: AgentOwnership<T>;
  constructor(ownership: AgentOwnership<T>) {
    this.ownership = ownership;
  }

  get(orbId: string, admissionVersion?: number): T | null {
    const owned = this.agents.get(orbId);
    return owned?.state === "owned" &&
      (admissionVersion === undefined ||
        (owned.admissionVersion === admissionVersion &&
          this.admissions.get(orbId) === admissionVersion))
      ? owned.agent
      : null;
  }

  private serial<R>(
    orbId: string,
    operation: () => PromiseLike<Result<R, RuntimeClientError>>,
  ): ResultAsync<R, RuntimeClientError> {
    const previous = this.queues.get(orbId) ?? Promise.resolve();
    const result = previous.then(operation);
    const barrier = result.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(orbId, barrier);
    void barrier.then(() => {
      if (this.queues.get(orbId) === barrier) this.queues.delete(orbId);
    });
    return ResultAsync.fromPromise(result, () =>
      durableError("agent ownership operation failed"),
    ).andThen((value) => value);
  }

  private retire(
    orbId: string,
    owner: AgentOwner<T>,
    refusal?: RuntimeClientError,
  ): ResultAsync<void, RuntimeClientError> {
    if (owner.state === "retiring") return owner.closed;
    const closed = this.ownership.close(owner.agent).map(() => {
      this.agents.delete(orbId);
      return undefined;
    });
    this.agents.set(orbId, { ...owner, state: "retiring", closed, refusal });
    return closed;
  }

  startupRefusal(orbId: string): RuntimeClientError | undefined {
    const owner = this.agents.get(orbId);
    if (owner?.state === "retiring" && !this.isOpening(orbId)) return owner.refusal;
  }

  admit(
    orbId: string,
    admissionVersion: number,
    resume: "always" | "newer" | "never",
  ): Result<void, RuntimeClientError> {
    const floor = this.admissions.get(orbId) ?? 0;
    if (this.closing || this.disposed.has(orbId))
      return err(durableError("agent admissions are closed"));
    if (admissionVersion < floor) return err(durableError("stale agent admission authority"));
    if (
      this.suspended.has(orbId) &&
      (resume === "never" ||
        (resume === "newer" && this.suspended.get(orbId) && admissionVersion === floor))
    )
      return err(durableError("agent admissions are closed"));
    this.admissions.set(orbId, admissionVersion);
    if (admissionVersion > floor) {
      this.suspended.delete(orbId);
      this.opening.get(orbId)?.abort("superseded" satisfies Revocation);
    }
    const previous = this.agents.get(orbId);
    if (previous?.state === "owned" && previous.admissionVersion < admissionVersion)
      this.ownership.revoke?.(previous.agent);
    return ok(undefined);
  }

  ensure(
    orbId: string,
    admissionVersion: number,
    open?: Open<T>,
    resume = false,
    waiter?: AbortSignal,
  ): ResultAsync<T, RuntimeClientError> {
    if (waiter?.aborted) return errAsync(cancelledOpen(false));
    const admission = this.admit(orbId, admissionVersion, resume ? "always" : "never");
    if (admission.isErr()) return errAsync(admission.error);
    const ticket = this.tickets.get(orbId) ?? 0;
    const admitted = () =>
      !this.closing &&
      !this.disposed.has(orbId) &&
      ticket === (this.tickets.get(orbId) ?? 0) &&
      this.admissions.get(orbId) === admissionVersion;
    return this.serial(orbId, async () => {
      if (waiter?.aborted) return err(cancelledOpen(false));
      if (!admitted()) return err(durableError("agent admission superseded"));
      if (resume && this.suspended.get(orbId) === false) this.suspended.delete(orbId);
      const existing = this.agents.get(orbId);
      if (
        existing?.state === "owned" &&
        existing.admissionVersion === admissionVersion &&
        this.ownership.active?.(existing.agent) !== false
      )
        return ok(existing.agent);
      if (existing) {
        const closed = await this.retire(orbId, existing);
        if (closed.isErr())
          return err(
            (existing.state === "retiring" ? existing.refusal : undefined) ?? closed.error,
          );
      }
      if (waiter?.aborted) return err(cancelledOpen(false));
      if (!admitted()) return err(durableError("agent admission superseded"));
      const controller = new AbortController();
      this.opening.set(orbId, controller);
      let candidate: Owned<T> | undefined;
      const publish: Publish<T> = (agent, openSignal) => {
        candidate = { state: "owned", admissionVersion, agent };
        if (openSignal?.aborted) return err(cancelledOpen());
        if (waiter?.aborted) return err(cancelledOpen(false));
        if (!admitted() || this.ownership.active?.(agent) === false)
          return err(durableError("agent admission superseded"));
        this.agents.set(orbId, candidate);
        return ok(undefined);
      };
      try {
        const opened = await ResultAsync.fromPromise(
          (async () =>
            open
              ? open(controller.signal, publish)
              : this.ownership.open(orbId, admissionVersion))(),
          () => durableError("agent ownership open failed"),
        ).andThen((result) => result);
        const result = opened.match<Result<T, RuntimeClientError>>(
          (agent) => (candidate ? ok(agent) : publish(agent).map(() => agent)),
          (failure) => {
            if (failure.type !== "startup_cleanup_failed") return err(failure);
            const { cleanupError, refusal } = failure;
            this.agents.set(orbId, {
              state: "retiring",
              admissionVersion,
              closed: errAsync(cleanupError),
              refusal,
            });
            return err(refusal ?? cleanupError);
          },
        );
        if (opened.isErr() && opened.error.type === "startup_cleanup_failed") return result;
        if (
          result.isOk() &&
          !waiter?.aborted &&
          admitted() &&
          this.ownership.active?.(result.value) !== false
        )
          return result;
        if (candidate) {
          const refusal = result.isErr() ? definitiveStartupRefusal(result.error) : undefined;
          const closed = await this.retire(orbId, candidate, refusal);
          if (closed.isErr()) return err(refusal ?? closed.error);
        }
        return result.isErr()
          ? result
          : err(
              waiter?.aborted ? cancelledOpen(false) : durableError("agent admission superseded"),
            );
      } finally {
        this.opening.delete(orbId);
      }
    });
  }

  isOpening(orbId: string): boolean {
    return this.opening.has(orbId);
  }

  hasNewerAuthority(orbId: string, throughAdmissionVersion: number): boolean {
    return (this.admissions.get(orbId) ?? 0) > throughAdmissionVersion;
  }

  suspend(
    orbId: string,
    throughAdmissionVersion?: number,
    origin: Revocation = "suspend",
  ): ResultAsync<void, RuntimeClientError> {
    if (
      throughAdmissionVersion !== undefined &&
      this.hasNewerAuthority(orbId, throughAdmissionVersion)
    )
      return okAsync(undefined);
    if (throughAdmissionVersion !== undefined) this.admissions.set(orbId, throughAdmissionVersion);
    this.suspended.set(
      orbId,
      throughAdmissionVersion !== undefined || this.suspended.get(orbId) === true,
    );
    const owned = this.agents.get(orbId);
    if (owned?.state === "owned") this.ownership.revoke?.(owned.agent);
    this.tickets.set(orbId, (this.tickets.get(orbId) ?? 0) + 1);
    this.opening.get(orbId)?.abort(origin);
    return this.serial(orbId, async () => {
      const existing = this.agents.get(orbId);
      if (
        !existing ||
        (throughAdmissionVersion !== undefined &&
          existing.admissionVersion > throughAdmissionVersion)
      )
        return ok(undefined);
      return this.retire(orbId, existing);
    });
  }

  unload(
    orbId: string,
    prepare: (agent: T) => ResultAsync<boolean, RuntimeClientError>,
  ): ResultAsync<boolean, RuntimeClientError> {
    return this.serial(orbId, async () => {
      const existing = this.agents.get(orbId);
      if (!existing) return ok(false);
      if (existing.state === "retiring") return this.retire(orbId, existing).map(() => true);
      const prepared = await prepare(existing.agent);
      if (prepared.isErr()) return err(prepared.error);
      if (!prepared.value) return ok(false);
      return this.retire(orbId, existing).map(() => true);
    });
  }

  dispose(orbId: string): ResultAsync<void, RuntimeClientError> {
    this.disposed.add(orbId);
    return this.suspend(orbId, undefined, "dispose");
  }

  close(): ResultAsync<void, RuntimeClientError> {
    this.closing = true;
    return ResultAsync.combine(
      [...new Set([...this.agents.keys(), ...this.queues.keys()])].map((id) =>
        this.suspend(id, undefined, "shutdown"),
      ),
    ).map(() => undefined);
  }
}

const POLL_STARTUP_BUDGET_MS = 30_000;

export const cancelledOpen = (retryable = true) => ({
  ...durableError("agent open cancelled", retryable),
  code: "cancelled" as const,
});

type StartupAbort = Revocation | "deadline" | "lease" | "composition";
type StartupStage = "check_ms" | "prepare_ms" | "lease_ms" | "compose_ms" | "harness_ms";

type StartupTrace = {
  readonly stages: Partial<Record<StartupStage, number>>;
  abortOrigin?: StartupAbort;
};

const elapsedMs = (task: SimulationTask, startedAt: number) =>
  Math.max(0, Math.round(task.monotonicNow() - startedAt));

// Determined deadlines are structurally compatible, but not native AbortSignals.
function relaySignal(signal: AbortSignal, abort: () => void): () => void {
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

type PollStartup = {
  readonly version: number;
  readonly readOnly: boolean;
  readonly trace: StartupTrace;
  readonly completion: ResultAsync<DurableAgent, RuntimeClientError>;
  invalidated: boolean;
  outcome?: Result<DurableAgent, RuntimeClientError>;
};

export interface DurableAgentPlaneOptions {
  /**
   * Run and join one startup on an independently owned task, not the poll lane.
   * The supplied task must remain usable by resources (e.g. the lease heartbeat)
   * for the lifetime of the owner. Without a runner, pollHealth joins ordinary
   * health on its caller's task (for scoped simulations).
   */
  readonly runStartup?: (
    orbId: string,
    run: (task: SimulationTask) => Promise<void>,
  ) => Promise<void>;
  readonly persistence: AgentPersistence;
  /** Persist required repository resources before acquiring an agent ownership lease. */
  readonly prepare?: (
    task: SimulationTask,
    orb: OrbRow,
    context: OperationContext,
  ) => ResultAsync<void, RuntimeClientError>;
  readonly currentOrb?: (
    task: SimulationTask,
    orbId: string,
  ) => ResultAsync<OrbRow | null, RuntimeClientError>;
  readonly cancelPending?: (
    task: SimulationTask,
    orb: OrbRow,
    operationId: string,
  ) => ResultAsync<"cancelled" | "active" | "missing" | undefined, RuntimeClientError>;
  /** Readiness, immutable guest binding, owner models and registry are application composition responsibilities. */
  readonly openContext: (
    task: SimulationTask,
    orb: OrbRow,
    context: OperationContext,
    readOnly?: boolean,
    lease?: AgentStorageLease,
  ) => ResultAsync<Omit<DurableAgentOptions, "storage" | "orbId">, RuntimeClientError>;
}

export class DurableAgentPlane implements AgentPlane, AgentAlertWriter {
  readonly placement = "central" as const;
  private readonly handles = new Map<string, StableAgentHandle>();
  private readonly pollStarts = new Map<string, PollStartup>();
  private readonly ownerModes = new WeakMap<DurableAgent, boolean>();
  private readonly contexts = new Map<string, { task: SimulationTask; orb: OrbRow }>();
  private readonly manager = new OrbAgentManager<DurableAgent>({
    open: () => errAsync(durableError("missing central agent open context")),
    close: (agent) => agent.close(),
    revoke: (agent) => agent.revoke(),
    active: (agent) => agent.accepting(),
  });
  private readonly options: DurableAgentPlaneOptions;
  private constructor(options: DurableAgentPlaneOptions) {
    this.options = options;
  }
  static create(
    options: DurableAgentPlaneOptions,
  ): ResultAsync<DurableAgentPlane, RuntimeClientError> {
    return okAsync(new DurableAgentPlane(options));
  }

  private handleFor(orbId: string): StableAgentHandle {
    let handle = this.handles.get(orbId);
    if (!handle) {
      handle = new StableAgentHandle(
        orbId,
        () => {
          const current = this.contexts.get(orbId);
          if (!current) return errAsync(durableError("conversation admission unavailable"));
          return (this.options.currentOrb?.(current.task, orbId) ?? okAsync(current.orb)).andThen(
            (latest) =>
              latest
                ? this.ensure(
                    current.task,
                    latest,
                    { signal: new AbortController().signal },
                    latest.stopReason === "manual" || latest.stopReason === "sleep",
                  )
                : errAsync(durableError("conversation no longer exists")),
          );
        },
        () => {
          const current = this.contexts.get(orbId);
          return current
            ? this.options.persistence.snapshot(current.task, current.orb)
            : errAsync(durableError("Conversation history unavailable"));
        },
        (operationId) => {
          const current = this.contexts.get(orbId);
          return current && this.options.cancelPending
            ? this.options.cancelPending(current.task, current.orb, operationId)
            : okAsync(undefined);
        },
      );
      this.handles.set(orbId, handle);
    }
    return handle;
  }

  recoveryDemand(task: SimulationTask, orb: OrbRow, context: OperationContext) {
    return this.options.persistence.recoveryDemand(task, orb, context);
  }

  checkStartup(task: SimulationTask, orb: OrbRow, context: OperationContext) {
    return this.options.persistence.checkStartup?.(task, orb, context) ?? okAsync(undefined);
  }

  private openAgent(
    task: SimulationTask,
    orb: OrbRow,
    context: OperationContext,
    readOnly: boolean,
    publish: Publish<DurableAgent>,
    trace?: StartupTrace,
  ): ResultAsync<DurableAgent, StartupFailure> {
    const timed = async <T>(stage: StartupStage, run: () => PromiseLike<T>): Promise<T> => {
      if (!trace) return run();
      const began = task.monotonicNow();
      try {
        return await run();
      } finally {
        trace.stages[stage] = elapsedMs(task, began);
      }
    };
    return ResultAsync.fromPromise(
      (async (): Promise<Result<DurableAgent, StartupFailure>> => {
        if (context.signal.aborted) return err(cancelledOpen());
        const checked = await timed("check_ms", () => this.checkStartup(task, orb, context));
        if (checked.isErr()) return err(startupError(checked.error, context.signal));
        if (context.signal.aborted) return err(cancelledOpen());
        const prepared = await timed(
          "prepare_ms",
          () => this.options.prepare?.(task, orb, context) ?? okAsync(undefined),
        );
        if (prepared.isErr()) return err(startupError(prepared.error, context.signal));
        if (context.signal.aborted) return err(cancelledOpen());
        const acquired = await timed("lease_ms", () =>
          this.options.persistence.open(task, orb, context),
        );
        if (acquired.isErr()) return err(startupError(acquired.error, context.signal));
        const lease = acquired.value;
        const operation = { signal: AbortSignal.any([context.signal, lease.signal]) };
        const detachLeaseTrace = relaySignal(lease.signal, () => {
          if (trace) trace.abortOrigin ??= "lease";
        });
        let released: ResultAsync<void, RuntimeClientError> | undefined;
        let handedOff = false;
        const release = () => {
          detachLeaseTrace();
          released ??= ResultAsync.fromThrowable(
            async () => lease.release(),
            () => durableError("agent ownership release failed"),
          )().andThen((result) => result);
          return released;
        };
        const opened = await ResultAsync.fromPromise(
          (async (): Promise<Result<DurableAgent, StartupFailure>> => {
            if (operation.signal.aborted) return err(cancelledOpen());
            const composed = await timed("compose_ms", () =>
              this.options.openContext(task, orb, operation, readOnly, lease),
            );
            if (composed.isErr()) return err(startupError(composed.error, operation.signal));
            const options = composed.value;
            const controller = new AbortController();
            const detachOpen =
              options.openSignal &&
              relaySignal(options.openSignal, () => {
                if (trace) trace.abortOrigin ??= "composition";
                controller.abort();
              });
            const openSignal = AbortSignal.any([operation.signal, controller.signal]);
            let detachOwner = () => {};
            const closeResources = () => {
              detachOpen?.();
              detachOwner();
              return ResultAsync.combine([
                ResultAsync.fromThrowable(
                  async () => options.closeResources?.() ?? okAsync(undefined),
                  () => durableError("agent startup resources close failed"),
                )().andThen((result) => result),
                release(),
              ]).map(() => undefined);
            };
            try {
              if (openSignal.aborted) {
                const closed = await closeResources();
                return err(closed.isErr() ? startupCleanupFailure(closed.error) : cancelledOpen());
              }
              return await timed("harness_ms", async () => {
                const built = await DurableAgent.build({
                  ...options,
                  ...(readOnly ? { resume: false } : {}),
                  orbId: orb.id,
                  storage: lease.storage,
                  openSignal,
                  ownershipSignal: lease.signal,
                  beginDrain: lease.beginDrain,
                  checkInputAdmission: lease.checkInputAdmission,
                  checkAdmission: () =>
                    lease.check().andThen(() => options.checkAdmission?.() ?? okAsync(undefined)),
                  closeResources,
                });
                if (built.isErr()) {
                  return built.error.type === "startup_cleanup_failed"
                    ? err(built.error)
                    : err(startupError(built.error, openSignal));
                }
                const agent = built.value;
                handedOff = true;
                const published = publish(agent, openSignal);
                if (published.isErr()) return err(published.error);
                this.ownerModes.set(agent, readOnly);
                detachOwner = relaySignal(lease.signal, () => {
                  agent.revoke();
                  void agent.close();
                });
                const activated = await agent.activate();
                return activated.isErr()
                  ? err(startupError(activated.error, openSignal))
                  : ok(agent);
              });
            } finally {
              detachOpen?.();
            }
          })(),
          () => (operation.signal.aborted ? cancelledOpen() : durableError("agent startup failed")),
        ).andThen((result) => result);
        detachLeaseTrace();
        if (!handedOff) {
          const cleanup = await release();
          if (cleanup.isErr()) {
            logOrbEvent(task, orb.id, "agent.startup_cleanup_failed", {
              code: cleanup.error.code,
              admission_version: orb.agentAdmissionVersion,
            });
            const cleanupError = cleanup.error;
            return opened.match<Result<DurableAgent, StartupFailure>>(
              () => err(startupCleanupFailure(cleanupError)),
              (failure) =>
                err(
                  failure.type === "startup_cleanup_failed"
                    ? failure
                    : startupCleanupFailure(cleanupError, failure),
                ),
            );
          }
        }
        return opened;
      })(),
      () => (context.signal.aborted ? cancelledOpen() : durableError("agent startup failed")),
    ).andThen((result) => result);
  }

  private attach(
    orb: OrbRow,
    agent: DurableAgent,
    readOnly: boolean,
  ): Result<DurableAgent, RuntimeClientError> {
    if (!readOnly && this.ownerModes.get(agent))
      return err(durableError("agent authority mode changed"));
    if (this.manager.get(orb.id, orb.agentAdmissionVersion) !== agent || !agent.accepting())
      return err(durableError("agent admission superseded"));
    this.handleFor(orb.id).attach(agent);
    return ok(agent);
  }

  private ensure(task: SimulationTask, orb: OrbRow, context: OperationContext, readOnly = false) {
    if (context.signal.aborted) return errAsync(cancelledOpen(false));
    const admission = this.manager.admit(
      orb.id,
      orb.agentAdmissionVersion,
      readOnly ? "always" : "newer",
    );
    if (admission.isErr()) return errAsync(admission.error);
    this.invalidateStartup(orb.id, "superseded", orb.agentAdmissionVersion - 1);
    this.rememberContext(task, orb);
    const start = this.pollStarts.get(orb.id);
    if (
      start &&
      !start.invalidated &&
      !start.outcome &&
      start.version === orb.agentAdmissionVersion
    ) {
      if (!readOnly && start.readOnly)
        return errAsync(durableError("agent authority mode changed"));
      return new ResultAsync(
        new Promise<Result<DurableAgent, RuntimeClientError>>((resolve) => {
          const abort = () => resolve(err(cancelledOpen(false)));
          context.signal.addEventListener("abort", abort, { once: true });
          void start.completion.then((result) => {
            context.signal.removeEventListener("abort", abort);
            if (context.signal.aborted) abort();
            else resolve(result);
          });
          if (context.signal.aborted) abort();
        }),
      );
    }
    return this.manager
      .ensure(
        orb.id,
        orb.agentAdmissionVersion,
        (scope, publish) => {
          const controller = new AbortController();
          const detach = relaySignal(context.signal, () => controller.abort());
          return this.openAgent(
            task,
            orb,
            { signal: AbortSignal.any([controller.signal, scope]) },
            readOnly,
            publish,
          )
            .andTee(detach)
            .orTee(detach);
        },
        true,
        context.signal,
      )
      .andThen((agent) =>
        context.signal.aborted ? err(cancelledOpen(false)) : this.attach(orb, agent, readOnly),
      );
  }

  private rememberContext(task: SimulationTask, orb: OrbRow) {
    const previous = this.contexts.get(orb.id)?.orb;
    if (
      !previous ||
      previous.agentAdmissionVersion < orb.agentAdmissionVersion ||
      (previous.agentAdmissionVersion === orb.agentAdmissionVersion &&
        previous.stateVersion <= orb.stateVersion)
    )
      this.contexts.set(orb.id, { task, orb });
  }

  private readonlyMode(orb: OrbRow): boolean {
    return (
      orb.stopReason === "manual" ||
      orb.stopReason === "sleep" ||
      orb.state === "deleting" ||
      orb.state === "archiving" ||
      orb.state === "archived"
    );
  }

  health(task: SimulationTask, orb: OrbRow, context: OperationContext) {
    return this.healthResult(orb, context, this.ensure(task, orb, context, this.readonlyMode(orb)));
  }

  private healthResult(
    orb: OrbRow,
    context: OperationContext,
    result: ResultAsync<DurableAgent, RuntimeClientError>,
  ) {
    return result
      .andThen((agent) => {
        if (context.signal.aborted) return err(cancelledOpen(false));
        if (!this.readonlyMode(orb) && this.ownerModes.get(agent))
          return err(durableError("agent authority mode changed"));
        if (this.manager.get(orb.id, orb.agentAdmissionVersion) !== agent || !agent.accepting())
          return err(durableError("agent admission superseded"));
        if (!this.readonlyMode(orb)) agent.resume();
        return ok(agent.health());
      })
      .orElse((failure) =>
        failure.answered && failure.initializationHealth !== undefined
          ? okAsync<RuntimeHealth, RuntimeClientError>(failure.initializationHealth)
          : failure.code === "initialization_failed" &&
              failure.answered &&
              failure.initializationError !== undefined
            ? okAsync<RuntimeHealth, RuntimeClientError>({
                v: 1,
                orbId: orb.id,
                runtimeInstanceId: `agent:${orb.id}`,
                status: "failed",
                error: failure.initializationError,
              })
            : errAsync(failure),
      );
  }

  pollHealth(
    task: SimulationTask,
    orb: OrbRow,
    context: OperationContext,
  ): ResultAsync<RuntimeHealth, RuntimeClientError> {
    if (context.signal.aborted) return errAsync(cancelledOpen(false));
    const runStartup = this.options.runStartup;
    if (!runStartup) return this.health(task, orb, context);
    const readOnly = this.readonlyMode(orb);
    const admission = this.manager.admit(orb.id, orb.agentAdmissionVersion, "newer");
    if (admission.isErr()) return errAsync(admission.error);
    this.invalidateStartup(orb.id, "superseded", orb.agentAdmissionVersion - 1);
    this.rememberContext(task, orb);
    const loading = (): ResultAsync<RuntimeHealth, RuntimeClientError> =>
      okAsync({
        v: 1,
        orbId: orb.id,
        runtimeInstanceId: `agent:${orb.id}`,
        status: "initializing",
        phase: "loading_session",
      });
    const previous = this.pollStarts.get(orb.id);
    if (previous) {
      if (!previous.outcome) return loading();
      this.pollStarts.delete(orb.id);
      if (
        !previous.invalidated &&
        previous.version === orb.agentAdmissionVersion &&
        previous.readOnly === readOnly &&
        previous.outcome.isErr()
      )
        return this.healthResult(orb, context, errAsync(previous.outcome.error));
    }
    const refusal = this.manager.startupRefusal(orb.id);
    if (refusal) return errAsync(refusal);
    const agent = this.manager.get(orb.id, orb.agentAdmissionVersion);
    if (agent?.accepting())
      return this.manager.isOpening(orb.id)
        ? loading()
        : this.healthResult(orb, context, okAsync(agent));

    let worker: SimulationTask | undefined;
    const began = task.monotonicNow();
    const trace: StartupTrace = { stages: {} };
    const completion = this.manager
      .ensure(
        orb.id,
        orb.agentAdmissionVersion,
        (scope, publish) =>
          ResultAsync.fromPromise(
            (async () => {
              let opened: Result<DurableAgent, StartupFailure> = err(
                durableError("agent startup worker unavailable", true),
              );
              const controller = new AbortController();
              const abort = (origin: StartupAbort) => {
                trace.abortOrigin ??= origin;
                controller.abort();
              };
              const detach = relaySignal(scope, () => abort(scope.reason as Revocation));
              try {
                await runStartup(orb.id, async (startupTask) => {
                  worker = startupTask;
                  if (controller.signal.aborted) {
                    opened = err(cancelledOpen());
                    return;
                  }
                  const deadline = startupTask.createDeadline(
                    POLL_STARTUP_BUDGET_MS,
                    "central agent poll startup",
                  );
                  const detachDeadline = relaySignal(deadline.signal, () => abort("deadline"));
                  try {
                    opened = await this.openAgent(
                      startupTask,
                      orb,
                      { signal: controller.signal },
                      readOnly,
                      publish,
                      trace,
                    );
                  } finally {
                    detachDeadline();
                    deadline.cancel();
                  }
                });
              } catch {
                return opened.isErr() && opened.error.type === "startup_cleanup_failed"
                  ? opened
                  : err(
                      controller.signal.aborted
                        ? cancelledOpen()
                        : durableError("agent startup worker failed", true),
                    );
              } finally {
                detach();
              }
              return opened.isOk() && controller.signal.aborted ? err(cancelledOpen()) : opened;
            })(),
            () => durableError("agent startup worker failed", true),
          ).andThen((result) => result),
        true,
      )
      .andThen((opened) => {
        const attached = this.attach(orb, opened, readOnly);
        if (attached.isOk() && worker) this.rememberContext(worker, orb);
        return attached;
      });
    const start: PollStartup = {
      version: orb.agentAdmissionVersion,
      readOnly,
      trace,
      completion,
      invalidated: false,
    };
    this.pollStarts.set(orb.id, start);
    void completion.then((outcome) => {
      start.outcome = outcome;
      if (start.invalidated && this.pollStarts.get(orb.id) === start)
        this.pollStarts.delete(orb.id);
      logOrbEvent(worker ?? task, orb.id, "agent.poll_startup_finished", {
        admission_version: start.version,
        duration_ms: elapsedMs(task, began),
        ...trace.stages,
        outcome: outcome.isOk() ? "opened" : "failed",
        error_code: outcome.isErr() ? outcome.error.code : undefined,
        abort_origin: trace.abortOrigin,
      });
    });
    return loading();
  }

  executionReady(
    task: SimulationTask,
    orb: OrbRow,
    context: OperationContext,
  ): ResultAsync<void, RuntimeClientError> {
    return this.health(task, orb, context).andThen((health) => {
      if (health.status === "failed")
        return errAsync({
          type: "runtime_client_error" as const,
          code: "initialization_failed" as const,
          answered: true,
          message: health.error.message,
          retryable: health.error.retryable,
          initializationError: health.error,
        });
      if (health.status === "initializing")
        return errAsync({
          ...durableError("central agent initializing", true),
          initializationHealth: health,
        });
      const agent = this.manager.get(orb.id, orb.agentAdmissionVersion);
      if (context.signal.aborted) return errAsync(cancelledOpen(false));
      return agent?.accepting()
        ? agent.checkExecutionReady(withAbortSignal(context.signal, BACKGROUND_CONTEXT))
        : errAsync(durableError("central agent unavailable", true));
    });
  }
  executionActive(orbId: string): boolean {
    return this.manager.get(orbId)?.executionActive() ?? false;
  }

  notifyParent(
    orbId: string,
    message: string,
    api: ToolExecutionApi,
    context: Context,
    expectedAdmissionVersion: number,
  ): ResultAsync<{ accepted: true }, OrbAgentError> {
    const agent = this.manager.get(orbId, expectedAdmissionVersion);
    return agent
      ? agent.notifyParent(message, api, context)
      : errAsync({ code: "unavailable", message: "Notification admission unavailable" });
  }

  appendAlert(
    orbId: string,
    requestId: string,
    message: string,
    expectedAdmissionVersion: number,
  ): ResultAsync<{ recordId: string; duplicate: boolean }, RuntimeClientError> {
    const agent = this.manager.get(orbId, expectedAdmissionVersion);
    return agent
      ? agent.appendAlert(requestId, message)
      : errAsync(durableError("central agent is not open", true));
  }

  readSession(task: SimulationTask, orb: OrbRow, context: OperationContext) {
    if (context.signal.aborted) return errAsync(durableError("conversation read cancelled"));
    this.rememberContext(task, orb);
    return okAsync(this.handleFor(orb.id));
  }

  unload(task: SimulationTask, orb: OrbRow, context: OperationContext) {
    const pending = () => {
      const startup = this.pollStarts.get(orb.id);
      return (startup && !startup.outcome) || this.manager.isOpening(orb.id);
    };
    const handle = this.handles.get(orb.id);
    if (!handle || context.signal.aborted || orb.state !== "stopped" || pending())
      return okAsync(false);
    return handle.admit(() =>
      pending()
        ? okAsync(false)
        : this.manager.unload(orb.id, (agent) => {
            return agent.prepareIdleStop().andThen((prepared) => {
              if (!prepared.prepared || agent.workActive() || agent.executionActive())
                return okAsync(false);
              return (this.options.currentOrb?.(task, orb.id) ?? okAsync(orb)).map(
                (current) =>
                  !context.signal.aborted &&
                  current?.state === "stopped" &&
                  current.agentAdmissionVersion === orb.agentAdmissionVersion &&
                  !agent.workActive() &&
                  !agent.executionActive(),
              );
            });
          }),
    );
  }

  session(orbId: string): AgentSessionFacade | null {
    return this.handles.get(orbId) ?? null;
  }

  deliverMessage(
    task: SimulationTask,
    orb: OrbRow,
    request: DeliverMessageClientRequest,
    context: OperationContext,
  ) {
    return this.deliverMessages(task, orb, [request], context).andThen(
      (responses) => responses[0] ?? err(durableError("message delivery response missing", true)),
    );
  }

  deliverMessages(
    _task: SimulationTask,
    orb: OrbRow,
    requests: readonly DeliverMessageClientRequest[],
    context: OperationContext,
  ) {
    if (context.signal.aborted)
      return errAsync({
        ...durableError("message admission cancelled"),
        code: "cancelled" as const,
      });
    const agent = this.manager.get(orb.id, orb.agentAdmissionVersion);
    const handle = this.handles.get(orb.id);
    return agent && handle
      ? handle.admit(() =>
          this.ensure(_task, orb, context).andThen((current) =>
            context.signal.aborted ? errAsync(cancelledOpen(false)) : current.deliverMany(requests),
          ),
        )
      : this.checkStartup(_task, orb, context).andThen(() =>
          errAsync(durableError("central agent is not open", true)),
        );
  }

  prepareIdleStop(_task: SimulationTask, orb: OrbRow, context: OperationContext) {
    if (context.signal.aborted) return errAsync(durableError("idle stop binding is stale"));
    const agent = this.manager.get(orb.id);
    return agent ? agent.prepareIdleStop() : okAsync({ v: 1 as const, prepared: true });
  }

  pullHistory(
    task: SimulationTask,
    orb: OrbRow,
    request: PullHistoryClientRequest,
    context: OperationContext,
  ) {
    if (context.signal.aborted)
      return errAsync({ ...durableError("history read cancelled"), code: "cancelled" as const });
    const agent = this.manager.get(orb.id);
    if (agent)
      return agent
        .pullHistory(request.after, request.limit)
        .orElse((error) =>
          error.code === "cursor_not_found"
            ? this.readCommittedHistory(task, orb, request)
            : errAsync(error),
        );
    return this.readCommittedHistory(task, orb, request);
  }

  private readCommittedHistory(
    task: SimulationTask,
    orb: OrbRow,
    request: PullHistoryClientRequest,
  ) {
    return this.options.persistence.snapshot(task, orb).andThen((snapshot) => {
      const index =
        request.after === null
          ? -1
          : snapshot.records.findIndex((record) => record.id === request.after);
      if (request.after !== null && index < 0)
        return errAsync({
          ...durableError("unknown history cursor"),
          code: "cursor_not_found" as const,
        });
      const records = snapshot.records.slice(
        index + 1,
        index + 1 + Math.max(1, Math.min(500, request.limit)),
      );
      const cursor = records.at(-1)?.id ?? request.after;
      return okAsync({
        v: 1 as const,
        orbId: orb.id,
        runtimeInstanceId: snapshot.runtimeInstanceId,
        session: snapshot.session,
        activity: "idle" as const,
        records,
        cursor,
        headId: cursor,
      });
    });
  }

  suspend(
    _task: SimulationTask,
    orbId: string,
    _context: OperationContext,
    throughAdmissionVersion?: number,
  ) {
    if (
      throughAdmissionVersion !== undefined &&
      this.manager.hasNewerAuthority(orbId, throughAdmissionVersion)
    )
      return okAsync(undefined);
    const suspended = this.manager.suspend(orbId, throughAdmissionVersion);
    const startup = this.invalidateStartup(orbId, "suspend", throughAdmissionVersion);
    return this.joinStartups(suspended, startup ? [startup] : []);
  }

  private invalidateStartup(orbId: string, origin: Revocation, throughAdmissionVersion?: number) {
    const start = this.pollStarts.get(orbId);
    if (
      !start ||
      (throughAdmissionVersion !== undefined && start.version > throughAdmissionVersion)
    )
      return undefined;
    start.invalidated = true;
    if (start.outcome) {
      this.pollStarts.delete(orbId);
      return undefined;
    }
    start.trace.abortOrigin ??= origin;
    return start.completion;
  }

  private joinStartups(
    operation: ResultAsync<void, RuntimeClientError>,
    startups: readonly ResultAsync<DurableAgent, RuntimeClientError>[],
  ): ResultAsync<void, RuntimeClientError> {
    if (startups.length === 0) return operation;
    return ResultAsync.fromSafePromise(Promise.all([operation, ...startups])).andThen(
      ([result]) => result,
    );
  }

  dispose(
    _task: SimulationTask,
    orbId: string,
    deleteAuthority: boolean,
    _context: OperationContext,
  ) {
    const startup = this.invalidateStartup(orbId, "dispose");
    return this.joinStartups(this.manager.dispose(orbId), startup ? [startup] : [])
      .map(() => {
        this.handles.get(orbId)?.dispose();
        this.handles.delete(orbId);
        this.contexts.delete(orbId);
        return undefined;
      })
      .andThen(() => this.options.persistence.dispose(_task, orbId, deleteAuthority));
  }
  close() {
    const closing = this.manager.close();
    const startups = [...this.pollStarts.keys()].flatMap((orbId) => {
      const startup = this.invalidateStartup(orbId, "shutdown");
      return startup ? [startup] : [];
    });
    return this.joinStartups(closing, startups)
      .map(() => {
        for (const handle of this.handles.values()) handle.dispose();
        this.handles.clear();
        this.contexts.clear();
        return undefined;
      })
      .andThen(() => this.options.persistence.close());
  }
}

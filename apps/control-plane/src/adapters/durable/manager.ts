import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { RuntimeHealth } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, errAsync, ok, okAsync, type Result, ResultAsync } from "neverthrow";
import type { AgentAlertWriter, AgentPlane, AgentSessionFacade } from "../../domain/agent-ports.ts";
import type { RuntimeClientError } from "../../domain/errors.ts";
import type { OrbRow } from "../../domain/orb.ts";
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

/** One mutation line per orb; shutdown joins every previously admitted open. */
export class OrbAgentManager<T> {
  private readonly agents = new Map<string, { admissionVersion: number; agent: T }>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly disposed = new Set<string>();
  private readonly suspended = new Set<string>();
  private readonly admissions = new Map<string, number>();
  private readonly tickets = new Map<string, number>();
  private closing = false;
  private readonly ownership: AgentOwnership<T>;
  constructor(ownership: AgentOwnership<T>) {
    this.ownership = ownership;
  }

  get(orbId: string, admissionVersion?: number): T | null {
    const owned = this.agents.get(orbId);
    return owned &&
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

  ensure(
    orbId: string,
    admissionVersion: number,
    open?: () => ResultAsync<T, RuntimeClientError>,
    resume = false,
  ): ResultAsync<T, RuntimeClientError> {
    if (this.closing || this.disposed.has(orbId) || (this.suspended.has(orbId) && !resume))
      return new ResultAsync(Promise.resolve(err(durableError("agent admissions are closed"))));
    if (admissionVersion < (this.admissions.get(orbId) ?? 0))
      return errAsync(durableError("stale agent admission authority"));
    this.admissions.set(orbId, admissionVersion);
    const previous = this.agents.get(orbId);
    if (previous && previous.admissionVersion < admissionVersion)
      this.ownership.revoke?.(previous.agent);
    const ticket = this.tickets.get(orbId) ?? 0;
    const admitted = () =>
      !this.closing &&
      !this.disposed.has(orbId) &&
      ticket === (this.tickets.get(orbId) ?? 0) &&
      this.admissions.get(orbId) === admissionVersion;
    return this.serial(orbId, async () => {
      if (!admitted()) return err(durableError("agent admission superseded"));
      if (resume) this.suspended.delete(orbId);
      const existing = this.agents.get(orbId);
      if (
        existing?.admissionVersion === admissionVersion &&
        this.ownership.active?.(existing.agent) !== false
      )
        return ok(existing.agent);
      if (existing) {
        const closed = await this.ownership.close(existing.agent);
        if (closed.isErr()) return err(closed.error);
        this.agents.delete(orbId);
      }
      const opened = await (open ? open() : this.ownership.open(orbId, admissionVersion));
      if (opened.isOk()) {
        if (!admitted()) {
          const closed = await this.ownership.close(opened.value);
          return closed.isErr()
            ? err(closed.error)
            : err(durableError("agent admission superseded"));
        }
        this.agents.set(orbId, { admissionVersion, agent: opened.value });
      }
      return opened;
    });
  }

  suspend(orbId: string, throughAdmissionVersion?: number): ResultAsync<void, RuntimeClientError> {
    if (
      throughAdmissionVersion !== undefined &&
      (this.admissions.get(orbId) ?? 0) > throughAdmissionVersion
    )
      return okAsync(undefined);
    if (throughAdmissionVersion !== undefined) this.admissions.set(orbId, throughAdmissionVersion);
    this.suspended.add(orbId);
    const owned = this.agents.get(orbId);
    if (owned) this.ownership.revoke?.(owned.agent);
    this.tickets.set(orbId, (this.tickets.get(orbId) ?? 0) + 1);
    return this.serial(orbId, async () => {
      const existing = this.agents.get(orbId);
      if (
        !existing ||
        (throughAdmissionVersion !== undefined &&
          existing.admissionVersion > throughAdmissionVersion)
      )
        return ok(undefined);
      const closed = await this.ownership.close(existing.agent);
      if (closed.isOk()) this.agents.delete(orbId);
      return closed;
    });
  }

  unload(
    orbId: string,
    prepare: (agent: T) => ResultAsync<boolean, RuntimeClientError>,
  ): ResultAsync<boolean, RuntimeClientError> {
    return this.serial(orbId, async () => {
      const existing = this.agents.get(orbId);
      if (!existing) return ok(false);
      const prepared = await prepare(existing.agent);
      if (prepared.isErr()) return err(prepared.error);
      if (!prepared.value) return ok(false);
      const closed = await this.ownership.close(existing.agent);
      if (closed.isErr()) return err(closed.error);
      this.agents.delete(orbId);
      return ok(true);
    });
  }

  dispose(orbId: string): ResultAsync<void, RuntimeClientError> {
    this.disposed.add(orbId);
    return this.suspend(orbId);
  }

  close(): ResultAsync<void, RuntimeClientError> {
    this.closing = true;
    return ResultAsync.combine(
      [...new Set([...this.agents.keys(), ...this.queues.keys()])].map((id) => this.suspend(id)),
    ).map(() => undefined);
  }
}

export interface DurableAgentPlaneOptions {
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
  private readonly opening = new Map<string, { version: number; abort: AbortController }>();
  private readonly contexts = new Map<
    string,
    { task: SimulationTask; orb: OrbRow; context: OperationContext }
  >();
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

  private ensure(task: SimulationTask, orb: OrbRow, context: OperationContext, readOnly = false) {
    if (context.signal.aborted)
      return errAsync({ ...durableError("agent open cancelled"), code: "cancelled" as const });
    this.contexts.set(orb.id, { task, orb, context });
    let opening = this.opening.get(orb.id);
    if (!opening || opening.version !== orb.agentAdmissionVersion || opening.abort.signal.aborted) {
      opening?.abort.abort();
      opening = { version: orb.agentAdmissionVersion, abort: new AbortController() };
      this.opening.set(orb.id, opening);
    }
    const admittedContext = { signal: AbortSignal.any([context.signal, opening.abort.signal]) };
    return this.manager
      .ensure(
        orb.id,
        orb.agentAdmissionVersion,
        () =>
          (this.options.prepare?.(task, orb, admittedContext) ?? okAsync(undefined))
            .andThen(() => this.options.persistence.open(task, orb, admittedContext))
            .andThen((lease) =>
              this.options
                .openContext(task, orb, admittedContext, readOnly, lease)
                .andThen((options) =>
                  DurableAgent.open({
                    ...options,
                    ...(readOnly ? { resume: false } : {}),
                    orbId: orb.id,
                    storage: lease.storage,
                    ownershipSignal: lease.signal,
                    beginDrain: lease.beginDrain,
                    checkAdmission: () =>
                      lease.check().andThen(() => options.checkAdmission?.() ?? okAsync(undefined)),
                    closeResources: () =>
                      ResultAsync.combine([
                        options.closeResources?.() ?? okAsync(undefined),
                        lease.release(),
                      ]).map(() => undefined),
                  }).map((agent) => {
                    lease.signal.addEventListener(
                      "abort",
                      () => {
                        agent.revoke();
                        void agent.close();
                      },
                      { once: true },
                    );
                    if (lease.signal.aborted) agent.revoke();
                    return agent;
                  }),
                )
                .orElse((error) => lease.release().andThen(() => errAsync(error))),
            ),
        true,
      )
      .map((agent) => {
        this.handleFor(orb.id).attach(agent);
        return agent;
      });
  }

  health(task: SimulationTask, orb: OrbRow, context: OperationContext) {
    return this.ensure(task, orb, context)
      .map((agent) => {
        if (
          orb.stopReason !== "manual" &&
          orb.stopReason !== "sleep" &&
          orb.state !== "deleting" &&
          orb.state !== "archiving" &&
          orb.state !== "archived"
        )
          agent.resume();
        return agent.health();
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

  executionReady(task: SimulationTask, orb: OrbRow, context: OperationContext) {
    return this.health(task, orb, context).andThen(() => {
      const agent = this.manager.get(orb.id);
      return agent
        ? agent.hydrateExecution(withAbortSignal(context.signal, BACKGROUND_CONTEXT))
        : errAsync(durableError("central agent unavailable"));
    });
  }
  executionActive(orbId: string): boolean {
    return this.manager.get(orbId)?.executionActive() ?? false;
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
    this.contexts.set(orb.id, { task, orb, context });
    return okAsync(this.handleFor(orb.id));
  }

  unload(task: SimulationTask, orb: OrbRow, context: OperationContext) {
    const handle = this.handles.get(orb.id);
    if (!handle || context.signal.aborted || orb.state !== "stopped") return okAsync(false);
    return handle.admit(() =>
      this.manager.unload(orb.id, (agent) => {
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
    _task: SimulationTask,
    orb: OrbRow,
    request: DeliverMessageClientRequest,
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
          this.ensure(_task, orb, context).andThen((current) => current.deliver(request)),
        )
      : errAsync(durableError("central agent is not open", true));
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
    if (agent) return agent.pullHistory(request.after, request.limit);
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
    const opening = this.opening.get(orbId);
    if (
      opening &&
      (throughAdmissionVersion === undefined || opening.version <= throughAdmissionVersion)
    )
      opening.abort.abort();
    return this.manager.suspend(orbId, throughAdmissionVersion);
  }
  dispose(
    _task: SimulationTask,
    orbId: string,
    deleteAuthority: boolean,
    _context: OperationContext,
  ) {
    this.opening.get(orbId)?.abort.abort();
    this.opening.delete(orbId);
    return this.manager
      .dispose(orbId)
      .map(() => {
        this.handles.get(orbId)?.dispose();
        this.handles.delete(orbId);
        this.contexts.delete(orbId);
        return undefined;
      })
      .andThen(() => this.options.persistence.dispose(_task, orbId, deleteAuthority));
  }
  close() {
    for (const opening of this.opening.values()) opening.abort.abort();
    this.opening.clear();
    return this.manager
      .close()
      .map(() => {
        for (const handle of this.handles.values()) handle.dispose();
        this.handles.clear();
        this.contexts.clear();
        return undefined;
      })
      .andThen(() => this.options.persistence.close());
  }
}

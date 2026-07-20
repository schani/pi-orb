import { ApplicationFailure, type SimulationTask } from "determined";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import type {
  HarnessSessionMetadata,
  HistoryRecord,
  PullHistoryResponse,
  RuntimeHealth,
} from "@pi-orb/protocol";
import type { OrbHostProviderError, RuntimeClientError } from "../domain/errors.ts";
import type {
  OperationContext,
  OrbHostObservation,
  OrbHostProvider,
  OrbHostRef,
  OrbHostState,
  OrbRuntimeClient,
  ProvisionOrbHostRequest,
  PullHistoryClientRequest,
} from "../domain/ports.ts";
import { FAILPOINTS } from "./failpoints.ts";

export type InitOutcome = "ready" | "failed_nonretryable" | "failed_retryable" | "never_ready";

export interface FakeOrbConfig {
  /** Time from host start until the runtime becomes ready. */
  initDurationMs?: number;
  initOutcome?: InitOutcome;
  checkoutCommit?: string;
}

/** The persistent filesystem: survives host stop/start and runtime restarts. */
interface FakeFilesystem {
  sessionId: string | null;
  header: HarnessSessionMetadata | null;
  entries: HistoryRecord[];
  headId: string | null;
}

interface FakeRuntimeInstance {
  instanceId: string;
  startedAtMonotonic: number;
  activity: "idle" | "busy";
}

interface FakeHost {
  ref: OrbHostRef;
  orbId: string;
  state: OrbHostState;
  runtime: FakeRuntimeInstance | null;
}

interface OrbWorldState {
  config: Required<FakeOrbConfig>;
  filesystem: FakeFilesystem;
  host: FakeHost | null;
  runtimeInstanceCounter: number;
  /** While > monotonic now, pulls return 503 history_unavailable. */
  pullOutageUntil: number;
  /** While > monotonic now, the runtime does not answer HTTP at all. */
  runtimeUnreachableUntil: number;
  /** When set, pull responses carry this orbId (host-routing mistake test). */
  reportOrbId: string | null;
}

const DEFAULT_CONFIG: Required<FakeOrbConfig> = {
  initDurationMs: 2_000,
  initOutcome: "ready",
  checkoutCommit: "commit-0",
};

/**
 * A deterministic world of orb hosts, runtimes, and persistent filesystems.
 * Tests drive it (append records, kill runtimes, corrupt sessions) while the
 * fake provider/client below expose it through the domain ports.
 */
export class FakeWorld {
  private readonly orbs = new Map<string, OrbWorldState>();
  private refCounter = 0;

  configureOrb(orbId: string, config: FakeOrbConfig = {}): void {
    this.orbs.set(orbId, {
      config: { ...DEFAULT_CONFIG, ...config },
      filesystem: { sessionId: null, header: null, entries: [], headId: null },
      host: null,
      runtimeInstanceCounter: 0,
      pullOutageUntil: 0,
      runtimeUnreachableUntil: 0,
      reportOrbId: null,
    });
  }

  private orbState(orbId: string): OrbWorldState {
    const state = this.orbs.get(orbId);
    if (state === undefined) throw new Error(`orb ${orbId} not configured in FakeWorld`);
    return state;
  }

  // -- test drivers ---------------------------------------------------------

  /** Append a complete message record to the orb's persistent session. */
  appendMessage(orbId: string, text?: string): HistoryRecord {
    const state = this.orbState(orbId);
    const fs = state.filesystem;
    if (fs.sessionId === null) throw new Error(`orb ${orbId} has no session yet`);
    const seq = fs.entries.length + 1;
    const parent = fs.entries.at(-1)?.id ?? null;
    const record: HistoryRecord = {
      id: `${orbId}-rec-${seq}`,
      parentId: parent,
      timestamp: `t${seq}`,
      overflow: { native: { seq } },
      type: "message",
      role: seq % 2 === 1 ? "user" : "assistant",
      content: [{ type: "text", text: text ?? `message ${seq}` }],
    };
    fs.entries.push(record);
    fs.headId = record.id;
    return record;
  }

  entriesOf(orbId: string): readonly HistoryRecord[] {
    return this.orbState(orbId).filesystem.entries;
  }

  sessionHeaderOf(orbId: string): HarnessSessionMetadata | null {
    return this.orbState(orbId).filesystem.header;
  }

  hostStateOf(orbId: string): OrbHostState | null {
    return this.orbState(orbId).host?.state ?? null;
  }

  runtimeInstanceIdOf(orbId: string): string | null {
    return this.orbState(orbId).host?.runtime?.instanceId ?? null;
  }

  setActivity(orbId: string, activity: "idle" | "busy"): void {
    const runtime = this.orbState(orbId).host?.runtime;
    if (runtime !== null && runtime !== undefined) runtime.activity = activity;
  }

  /** Simulate a runtime-process crash and supervised restart inside the host. */
  restartRuntimeProcess(task: SimulationTask, orbId: string): void {
    const state = this.orbState(orbId);
    if (state.host === null || state.host.state !== "running") return;
    state.runtimeInstanceCounter += 1;
    state.host.runtime = {
      instanceId: `${orbId}-runtime-${state.runtimeInstanceCounter}`,
      startedAtMonotonic: task.monotonicNow(),
      activity: "idle",
    };
  }

  /** Kill the runtime process without restart: HTTP goes dark until host restart. */
  killRuntimeProcess(orbId: string): void {
    const state = this.orbState(orbId);
    if (state.host !== null) state.host.runtime = null;
  }

  setPullOutage(task: SimulationTask, orbId: string, durationMs: number): void {
    this.orbState(orbId).pullOutageUntil = task.monotonicNow() + durationMs;
  }

  setRuntimeUnreachable(task: SimulationTask, orbId: string, durationMs: number): void {
    this.orbState(orbId).runtimeUnreachableUntil = task.monotonicNow() + durationMs;
  }

  /** Corrupt the persisted session header: the next pull reports a different session. */
  corruptSession(orbId: string): void {
    const fs = this.orbState(orbId).filesystem;
    if (fs.sessionId === null) throw new Error(`orb ${orbId} has no session to corrupt`);
    fs.sessionId = `${fs.sessionId}-corrupt`;
    fs.header = {
      id: fs.sessionId,
      overflow: { native: { id: fs.sessionId } },
    };
  }

  /** Truncate persisted entries so committed cursors dangle (cursor_not_found). */
  truncateEntries(orbId: string, keep: number): void {
    const fs = this.orbState(orbId).filesystem;
    fs.entries = fs.entries.slice(0, keep);
    fs.headId = fs.entries.at(-1)?.id ?? null;
  }

  reportWrongOrbId(orbId: string, reportedOrbId: string): void {
    this.orbState(orbId).reportOrbId = reportedOrbId;
  }

  /** Count of hosts that exist (any state) for invariant checks. */
  hostCount(orbId: string): number {
    return this.orbState(orbId).host === null ? 0 : 1;
  }

  // -- internal transitions used by the provider ----------------------------

  /** Create the persistent session if none exists (as a ready runtime would). */
  ensureSessionExists(orbId: string): void {
    const fs = this.orbState(orbId).filesystem;
    if (fs.sessionId === null) {
      fs.sessionId = `${orbId}-session-1`;
      fs.header = { id: fs.sessionId, overflow: { native: { id: fs.sessionId } } };
    }
  }

  provisionHost(task: SimulationTask, orbId: string): OrbHostRef {
    const state = this.orbState(orbId);
    if (state.host !== null) {
      // Idempotent: return the existing host, starting it if stopped.
      if (state.host.state === "stopped" || state.host.state === "failed") {
        this.startHost(task, state.host.ref);
      }
      return state.host.ref;
    }
    this.refCounter += 1;
    const ref: OrbHostRef = { provider: "fake", resourceId: `host-${orbId}-${this.refCounter}` };
    state.host = { ref, orbId, state: "running", runtime: null };
    this.bootRuntime(task, orbId);
    return ref;
  }

  startHost(task: SimulationTask, ref: OrbHostRef): void {
    const state = this.findByRef(ref);
    if (state === null || state.host === null) return;
    if (state.host.state === "running") return;
    state.host.state = "running";
    this.bootRuntime(task, state.host.orbId);
  }

  stopHost(ref: OrbHostRef): void {
    const state = this.findByRef(ref);
    if (state === null || state.host === null) return;
    state.host.state = "stopped";
    state.host.runtime = null;
  }

  private bootRuntime(task: SimulationTask, orbId: string): void {
    const state = this.orbState(orbId);
    if (state.host === null) return;
    state.runtimeInstanceCounter += 1;
    state.host.runtime = {
      instanceId: `${orbId}-runtime-${state.runtimeInstanceCounter}`,
      startedAtMonotonic: task.monotonicNow(),
      activity: "idle",
    };
  }

  findByRef(ref: OrbHostRef): OrbWorldState | null {
    for (const state of this.orbs.values()) {
      if (state.host?.ref.resourceId === ref.resourceId) return state;
    }
    return null;
  }

  observeHost(ref: OrbHostRef): OrbHostObservation | null {
    const state = this.findByRef(ref);
    if (state === null || state.host === null) return null;
    const observation: OrbHostObservation = {
      ref: state.host.ref,
      orbId: state.host.orbId,
      state: state.host.state,
      ...(state.host.state === "running"
        ? { runtimeAddress: { baseUrl: `http://${state.host.ref.resourceId}:8080` } }
        : {}),
    };
    return observation;
  }

  listHosts(): OrbHostObservation[] {
    const result: OrbHostObservation[] = [];
    for (const state of this.orbs.values()) {
      if (state.host !== null) {
        const observation = this.observeHost(state.host.ref);
        if (observation !== null) result.push(observation);
      }
    }
    return result;
  }

  // -- runtime protocol view -----------------------------------------------

  resolveRuntime(baseUrl: string, task: SimulationTask): OrbWorldState | null {
    for (const state of this.orbs.values()) {
      if (
        state.host !== null &&
        `http://${state.host.ref.resourceId}:8080` === baseUrl &&
        state.host.state === "running" &&
        state.host.runtime !== null &&
        state.runtimeUnreachableUntil <= task.monotonicNow()
      ) {
        return state;
      }
    }
    return null;
  }

  runtimeHealth(task: SimulationTask, state: OrbWorldState): RuntimeHealth {
    const host = state.host;
    if (host === null || host.runtime === null) throw new Error("runtimeHealth on dead runtime");
    const runtime = host.runtime;
    const orbId = state.reportOrbId ?? host.orbId;
    const elapsed = task.monotonicNow() - runtime.startedAtMonotonic;
    const initializing: RuntimeHealth = {
      v: 1,
      orbId,
      runtimeInstanceId: runtime.instanceId,
      status: "initializing",
      phase: "loading_session",
    };
    if (elapsed < state.config.initDurationMs) return initializing;
    switch (state.config.initOutcome) {
      case "never_ready":
        return initializing;
      case "failed_nonretryable":
        return {
          v: 1,
          orbId,
          runtimeInstanceId: runtime.instanceId,
          status: "failed",
          error: { code: "session_load_failed", message: "session corrupt", retryable: false },
        };
      case "failed_retryable":
        return {
          v: 1,
          orbId,
          runtimeInstanceId: runtime.instanceId,
          status: "failed",
          error: { code: "clone_failed", message: "network flake", retryable: true },
        };
      case "ready": {
        this.ensureSessionExists(host.orbId);
        const fs = state.filesystem;
        if (fs.sessionId === null) throw new Error("session must exist when ready");
        return {
          v: 1,
          orbId,
          runtimeInstanceId: runtime.instanceId,
          status: "ready",
          sessionId: fs.sessionId,
          checkoutCommit: state.config.checkoutCommit,
          activity: runtime.activity,
        };
      }
    }
  }
}

// ---------------------------------------------------------------------------

const providerError = (
  operation: OrbHostProviderError["operation"],
  code: OrbHostProviderError["code"],
  message: string,
  retryable: boolean,
): OrbHostProviderError => ({
  type: "orb_host_provider_error",
  provider: "fake",
  operation,
  code,
  message,
  retryable,
});

export class FakeOrbHostProvider implements OrbHostProvider {
  readonly kind = "fake";
  private readonly world: FakeWorld;
  private readonly maxLatencyMs: number;

  constructor(world: FakeWorld, maxLatencyMs: number = 50) {
    this.world = world;
    this.maxLatencyMs = maxLatencyMs;
  }

  private op<T>(
    task: SimulationTask,
    operation: OrbHostProviderError["operation"],
    failpoint: string,
    context: OperationContext,
    f: () => T,
  ): ResultAsync<T, OrbHostProviderError> {
    const run = async (): Promise<T> => {
      await task.sleep(
        1 + task.random(`provider latency: ${operation}`) * this.maxLatencyMs,
        `provider ${operation}`,
        { signal: context.signal },
      );
      await task.failpoint(failpoint, operation);
      return f();
    };
    return ResultAsync.fromPromise(run(), (error) => {
      if (error instanceof ApplicationFailure) {
        return providerError(operation, "unavailable", error.message, true);
      }
      // Cancellation (deadline) or anything else: typed `cancelled`.
      return providerError(operation, "cancelled", String(error), true);
    });
  }

  provision(
    task: SimulationTask,
    request: ProvisionOrbHostRequest,
    context: OperationContext,
  ): ResultAsync<OrbHostRef, OrbHostProviderError> {
    return this.op(task, "provision", FAILPOINTS.providerProvision, context, () =>
      this.world.provisionHost(task, request.orbId),
    );
  }

  start(
    task: SimulationTask,
    ref: OrbHostRef,
    context: OperationContext,
  ): ResultAsync<void, OrbHostProviderError> {
    return this.op(task, "start", FAILPOINTS.providerStart, context, () =>
      this.world.startHost(task, ref),
    );
  }

  stop(
    task: SimulationTask,
    ref: OrbHostRef,
    context: OperationContext,
  ): ResultAsync<void, OrbHostProviderError> {
    return this.op(task, "stop", FAILPOINTS.providerStop, context, () => this.world.stopHost(ref));
  }

  observe(
    task: SimulationTask,
    ref: OrbHostRef,
    context: OperationContext,
  ): ResultAsync<OrbHostObservation | null, OrbHostProviderError> {
    return this.op(task, "observe", FAILPOINTS.providerObserve, context, () =>
      this.world.observeHost(ref),
    );
  }

  listManagedHosts(
    task: SimulationTask,
    context: OperationContext,
  ): ResultAsync<OrbHostObservation[], OrbHostProviderError> {
    return this.op(task, "list", FAILPOINTS.providerObserve, context, () => this.world.listHosts());
  }
}

// ---------------------------------------------------------------------------

const clientError = (
  code: RuntimeClientError["code"],
  message: string,
  retryable: boolean,
): RuntimeClientError => ({ type: "runtime_client_error", code, message, retryable });

export class FakeRuntimeClient implements OrbRuntimeClient {
  private readonly world: FakeWorld;
  private readonly maxLatencyMs: number;

  constructor(world: FakeWorld, maxLatencyMs: number = 20) {
    this.world = world;
    this.maxLatencyMs = maxLatencyMs;
  }

  private req<T>(
    task: SimulationTask,
    failpoint: string,
    reason: string,
    context: OperationContext,
    f: () => ResultAsync<T, RuntimeClientError>,
  ): ResultAsync<T, RuntimeClientError> {
    const run = async (): Promise<void> => {
      await task.sleep(1 + task.random(`runtime latency: ${reason}`) * this.maxLatencyMs, reason, {
        signal: context.signal,
      });
      await task.failpoint(failpoint, reason);
    };
    return ResultAsync.fromPromise(run(), (error) => {
      if (error instanceof ApplicationFailure) {
        return clientError("unreachable", `${reason}: ${error.message}`, true);
      }
      return clientError("cancelled", `${reason}: cancelled`, true);
    }).andThen(f);
  }

  health(
    task: SimulationTask,
    baseUrl: string,
    context: OperationContext,
  ): ResultAsync<RuntimeHealth, RuntimeClientError> {
    return this.req(task, FAILPOINTS.runtimeHealth, "health", context, () => {
      const state = this.world.resolveRuntime(baseUrl, task);
      if (state === null) return errAsync(clientError("unreachable", "no runtime", true));
      return okAsync(this.world.runtimeHealth(task, state));
    });
  }

  pullHistory(
    task: SimulationTask,
    request: PullHistoryClientRequest,
    context: OperationContext,
  ): ResultAsync<PullHistoryResponse, RuntimeClientError> {
    return this.req(task, FAILPOINTS.runtimePull, "pull history", context, () => {
      const state = this.world.resolveRuntime(request.baseUrl, task);
      if (state === null) return errAsync(clientError("unreachable", "no runtime", true));
      const health = this.world.runtimeHealth(task, state);
      if (health.status !== "ready") {
        return errAsync(clientError("history_unavailable", "runtime not ready", true));
      }
      if (state.pullOutageUntil > task.monotonicNow()) {
        return errAsync(clientError("history_unavailable", "scripted outage", true));
      }
      const host = state.host;
      if (host === null || host.runtime === null) {
        return errAsync(clientError("unreachable", "no runtime", true));
      }
      const fs = state.filesystem;
      if (fs.header === null) {
        return errAsync(clientError("history_unavailable", "no session", true));
      }
      // Synchronous snapshot of persisted entries.
      const entries = [...fs.entries];
      let startIndex = 0;
      if (request.after !== null) {
        const index = entries.findIndex((record) => record.id === request.after);
        if (index === -1) {
          return errAsync(
            clientError("cursor_not_found", `unknown cursor ${request.after}`, false),
          );
        }
        startIndex = index + 1;
      }
      const records = entries.slice(startIndex, startIndex + request.limit);
      const cursor = records.at(-1)?.id ?? request.after;
      const lastReturnedIndex = startIndex + records.length - 1;
      // headId must be represented by the returned prefix.
      const headIndex = fs.headId === null ? -1 : entries.findIndex((r) => r.id === fs.headId);
      const headId =
        headIndex !== -1 && headIndex <= lastReturnedIndex
          ? fs.headId
          : (records.at(-1)?.id ?? request.after);
      return okAsync<PullHistoryResponse, RuntimeClientError>({
        v: 1,
        orbId: state.reportOrbId ?? host.orbId,
        runtimeInstanceId: host.runtime.instanceId,
        activity: host.runtime.activity,
        session: fs.header,
        records,
        cursor,
        headId,
      });
    });
  }
}

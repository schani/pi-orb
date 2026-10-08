import type {
  ActiveSubagent,
  AgentSettingsEvent,
  ClientAction,
  DeliverOrbMessageResponse,
  HarnessSessionMetadata,
  HistoryRecord,
  PrepareIdleStopResponse,
  PullHistoryResponse,
  RequestResultFrame,
  RuntimeHealth,
  ServerFrame,
} from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import type { Result, ResultAsync } from "neverthrow";
import type { RuntimeClientError } from "./errors.ts";
import type { OrbRow } from "./orb.ts";
import type {
  DeliverMessageClientRequest,
  OperationContext,
  PullHistoryClientRequest,
} from "./ports.ts";

/** Immutable identity: an invocation must never retarget a replacement guest. */
export interface AgentEndpoint {
  readonly baseUrl: string;
  readonly incarnation: number;
}

export interface AgentSnapshot {
  readonly orbId: string;
  readonly runtimeInstanceId: string;
  readonly activity: "idle" | "busy";
  readonly session: HarnessSessionMetadata;
  readonly records: readonly HistoryRecord[];
  readonly headId: string | null;
  readonly settings?: AgentSettingsEvent | null;
}

export interface AgentLiveView {
  readonly operationId: string;
  readonly operationKind: "agent";
  readonly blocks: readonly {
    blockId: string;
    blockType: "text" | "reasoning";
    contentIndex: number;
    revision: number;
    text: string;
  }[];
  readonly tools: readonly {
    callId: string;
    name: string;
    revision: number;
    state: "running" | "completed" | "failed";
    message?: string;
  }[];
  readonly subagents: readonly ActiveSubagent[];
}

/** Synchronous snapshot/subscription capture prevents a browser handoff gap. */
export interface AgentSessionFacade {
  readonly runtimeInstanceId: string;
  /** Actual root/child/submission work, excluding projection and summaries. */
  workActive?(): boolean;
  snapshot(): Result<AgentSnapshot, { readonly message: string }>;
  /** Passive state is read on demand, not retained by an unloaded handle. */
  readSnapshot?(): ResultAsync<AgentSnapshot, RuntimeClientError>;
  liveView(): AgentLiveView | null;
  /** Owner invalidation requires a fresh cursor-aware browser handshake. */
  subscribe(listener: (frame: ServerFrame) => void, onInvalidated?: () => void): () => void;
  request(
    requestId: string,
    action: ClientAction,
  ): ResultAsync<RequestResultFrame["result"], RuntimeClientError>;
}

/** Native transcript alerts acknowledged only after the derived-history barrier. */
export interface AgentAlertWriter {
  appendAlert(
    orbId: string,
    requestId: string,
    message: string,
    expectedAdmissionVersion: number,
  ): ResultAsync<{ recordId: string; duplicate: boolean }, RuntimeClientError>;
}

/** Central application boundary; no Harness, Chord, socket or database types. */
export interface AgentPlane {
  readonly placement: "central" | "host";
  placementFor?(orb: OrbRow): "central" | "host";
  /** Read-only compatibility preflight; actual open/mutation admission rechecks authority. */
  checkStartup?(
    task: SimulationTask,
    orb: OrbRow,
    context: OperationContext,
  ): ResultAsync<void, RuntimeClientError>;
  health(
    task: SimulationTask,
    orb: OrbRow,
    context: OperationContext,
  ): ResultAsync<RuntimeHealth, RuntimeClientError>;
  /** Hydrate host-authoritative resources after guest ready, before publishing compute readiness. */
  executionReady?(
    task: SimulationTask,
    orb: OrbRow,
    context: OperationContext,
  ): ResultAsync<void, RuntimeClientError>;
  /** Outstanding immutable VM invocation leases, excluding model/CP work. */
  executionActive?(orbId: string): boolean;
  deliverMessage(
    task: SimulationTask,
    orb: OrbRow,
    request: DeliverMessageClientRequest,
    context: OperationContext,
  ): ResultAsync<DeliverOrbMessageResponse, RuntimeClientError>;
  prepareIdleStop(
    task: SimulationTask,
    orb: OrbRow,
    context: OperationContext,
  ): ResultAsync<PrepareIdleStopResponse, RuntimeClientError>;
  pullHistory(
    task: SimulationTask,
    orb: OrbRow,
    request: PullHistoryClientRequest,
    context: OperationContext,
  ): ResultAsync<PullHistoryResponse, RuntimeClientError>;
  /** Suspend, never terminal user-abort; idempotent when not open. */
  suspend(
    task: SimulationTask,
    orbId: string,
    context: OperationContext,
    throughAdmissionVersion?: number,
  ): ResultAsync<void, RuntimeClientError>;
  /** Archive seals public history and removes private authority. */
  dispose(
    task: SimulationTask,
    orbId: string,
    deleteAuthority: boolean,
    context: OperationContext,
  ): ResultAsync<void, RuntimeClientError>;
  /** Passive conversation attachment never constructs model/tool resources. */
  readSession?(
    task: SimulationTask,
    orb: OrbRow,
    context: OperationContext,
  ): ResultAsync<AgentSessionFacade, RuntimeClientError>;
  /** Host stopped and optional state quiescent; does not inhibit new agent work. */
  unload?(
    task: SimulationTask,
    orb: OrbRow,
    context: OperationContext,
  ): ResultAsync<boolean, RuntimeClientError>;
  session(orbId: string): AgentSessionFacade | null;
  close(): ResultAsync<void, RuntimeClientError>;
}

import type {
  CommittedDisplayDetail,
  DeliverOrbMessageResponse,
  LiveDisplayDetail,
  MessageInputBlock,
  OrbMessageSystem,
  RuntimeAlertRequest,
  RuntimeAlertResponse,
  RuntimeHealth,
  ServerFrame,
  SettingsAction,
} from "@pi-orb/protocol";
import type { Result, ResultAsync } from "neverthrow";
import type { HookEnvSource } from "../hooks/env-file.ts";
import type { AgentGateView } from "./requests.ts";
import type { HarnessSnapshot, LiveOperationView } from "./types.ts";

export interface CompactError {
  readonly code: "busy" | "unsupported" | "internal";
  readonly message: string;
}

export interface SnapshotError {
  readonly type: "snapshot_error";
  readonly message: string;
}
export interface DetailError {
  readonly type: "detail_unavailable" | "detail_not_found";
  readonly message: string;
}

/** Harness-owned behavior; HTTP never reads native sessions or drives an SDK. */
export interface OrbAgent {
  readonly runtimeInstanceId: string;
  boot(): Promise<void>;
  getHealth(): RuntimeHealth;
  hookEnvSource(): HookEnvSource;
  shutdownHooks(): void;
  closeExtensions(): Promise<void>;
  subscribe(listener: (frame: ServerFrame) => void): () => void;
  snapshot(): Result<HarnessSnapshot, SnapshotError>;
  replicationSnapshot(): Result<HarnessSnapshot, SnapshotError>;
  sessionId(): string | null;
  gateView(): AgentGateView;
  liveView(): LiveOperationView | null;
  prepareIdleStop(): Result<boolean, { message: string }>;
  appendAlert(
    request: RuntimeAlertRequest,
  ): Result<RuntimeAlertResponse, { code: "unavailable" | "conflict"; message: string }>;
  readDisplayDetail(
    recordId: string,
    detailKey: string,
  ): Result<CommittedDisplayDetail, DetailError>;
  readDisplayImage(
    recordId: string,
    detailKey: string,
    imageIndex: number,
  ): Result<{ mediaType: string; data: Buffer }, DetailError>;
  readLiveDisplayDetail(operationId: string, blockId: string): LiveDisplayDetail;
  changeSettings(
    action: SettingsAction,
  ): ResultAsync<
    void,
    { code: "busy" | "invalid_request" | "internal" | "unsupported"; message: string }
  >;
  deliverInboxMessage(
    messageId: string,
    messageIds: readonly string[],
    content: readonly MessageInputBlock[],
    system?: OrbMessageSystem,
  ): ResultAsync<DeliverOrbMessageResponse, { message: string; retryable: boolean }>;
  submitMessage(
    content: readonly MessageInputBlock[],
    operationId: string,
  ): ResultAsync<void, { message: string }>;
  canCompact(): Result<void, { code: "busy" | "unsupported"; message: string }>;
  compact(
    customInstructions: string | undefined,
    operationId: string,
  ): ResultAsync<void, CompactError>;
  abortOperation(source?: "user" | "shutdown"): ResultAsync<void, { message: string }>;
  triggerAutoName(content: readonly MessageInputBlock[]): void;
}

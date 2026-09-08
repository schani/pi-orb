import type { SimulationTask } from "determined";
import type { ResultAsync } from "neverthrow";
import type {
  HostedFile,
  HostedFileInventory,
  HostedObjectRef,
  HostingAttempt,
  HostingCleanupClaim,
  HostingError,
  HostingOperation,
  HostingUploadRequest,
  StoredHostedObject,
} from "./hosting-types.ts";
import type { OperationContext } from "./ports.ts";

/** A pull source whose failures remain typed across the first-party boundary. */
export interface HostedByteSource {
  next(
    task: SimulationTask,
    context: OperationContext,
  ): ResultAsync<Uint8Array | null, HostingError>;
  close(task: SimulationTask): ResultAsync<void, HostingError>;
}

export interface HostedByteStore {
  /** Creates an empty resumable session. No source bytes are accepted here. */
  begin(
    task: SimulationTask,
    objectKey: string,
    expected: { readonly size: number; readonly sha256: string },
    context: OperationContext,
  ): ResultAsync<{ sessionId: string }, HostingError>;
  write(
    task: SimulationTask,
    sessionId: string,
    source: HostedByteSource,
    expected: { readonly size: number; readonly sha256: string },
    context: OperationContext,
  ): ResultAsync<StoredHostedObject, HostingError>;
  query(
    task: SimulationTask,
    sessionId: string,
    context: OperationContext,
  ): ResultAsync<
    | { readonly type: "active" }
    | { readonly type: "cancelled" }
    | { readonly type: "committed"; readonly object: StoredHostedObject },
    HostingError
  >;
  /** Success proves the session cannot accept more bytes; completion wins a cancellation race. */
  cancel(
    task: SimulationTask,
    sessionId: string,
    context: OperationContext,
  ): ResultAsync<
    | { readonly type: "cancelled" }
    | { readonly type: "committed"; readonly object: StoredHostedObject },
    HostingError
  >;
  statExact(
    task: SimulationTask,
    object: HostedObjectRef,
    context: OperationContext,
  ): ResultAsync<StoredHostedObject | null, HostingError>;
  openExact(
    task: SimulationTask,
    object: HostedObjectRef,
    context: OperationContext,
  ): ResultAsync<
    {
      readonly object: StoredHostedObject;
      /** EOF is returned only after streamed size/hash match `object`; mismatch is a typed error. */
      readonly source: HostedByteSource;
    },
    HostingError
  >;
  deleteExact(
    task: SimulationTask,
    object: HostedObjectRef,
    context: OperationContext,
  ): ResultAsync<void, HostingError>;
}

export interface HostingStore {
  reserveUpload(
    task: SimulationTask,
    request: HostingUploadRequest,
  ): ResultAsync<HostingOperation, HostingError>;
  claimUpload(
    task: SimulationTask,
    params: {
      readonly operationId: string;
      readonly owner: string;
      readonly now: number;
      readonly leaseUntil: number;
    },
  ): ResultAsync<
    | { readonly type: "published"; readonly file: HostedFile }
    | { readonly type: "busy" }
    | { readonly type: "claimed"; readonly attempt: HostingAttempt; readonly takeover: boolean },
    HostingError
  >;
  abandonEmptyAttempt(
    task: SimulationTask,
    attemptId: string,
    epoch: number,
  ): ResultAsync<void, HostingError>;
  registerSession(
    task: SimulationTask,
    attemptId: string,
    epoch: number,
    sessionId: string,
  ): ResultAsync<HostingAttempt, HostingError>;
  recordCommit(
    task: SimulationTask,
    attemptId: string,
    epoch: number,
    object: StoredHostedObject,
  ): ResultAsync<HostingAttempt, HostingError>;
  publishUpload(
    task: SimulationTask,
    operationId: string,
    attemptId: string,
    epoch: number,
    now: number,
  ): ResultAsync<HostedFile, HostingError>;
  listFiles(task: SimulationTask, orbId: string): ResultAsync<HostedFile[], HostingError>;
  getInventory(task: SimulationTask, orbId: string): ResultAsync<HostedFileInventory, HostingError>;
  resolveFile(
    task: SimulationTask,
    orbId: string,
    path: string,
  ): ResultAsync<HostedFile | null, HostingError>;
  unpublishExact(
    task: SimulationTask,
    caller: {
      readonly orbId: string;
      readonly runtimeTokenHash: string;
      readonly incarnation: number;
    },
    path: string,
    expected: HostedObjectRef | undefined,
  ): ResultAsync<void, HostingError>;
  /** Fences future reserve/publish and returns every durable owner needing cleanup. */
  beginOrbCleanup(task: SimulationTask, orbId: string): ResultAsync<void, HostingError>;
  claimCleanup(
    task: SimulationTask,
    params: {
      readonly orbId?: string;
      readonly owner: string;
      readonly now: number;
      readonly leaseUntil: number;
      readonly limit: number;
    },
  ): ResultAsync<HostingCleanupClaim[], HostingError>;
  recordCleanupFailure(
    task: SimulationTask,
    itemId: string,
    epoch: number,
    message: string,
    now: number,
  ): ResultAsync<void, HostingError>;
  recordCleanupObject(
    task: SimulationTask,
    itemId: string,
    epoch: number,
    object: HostedObjectRef,
  ): ResultAsync<void, HostingError>;
  finishClaimedCleanup(
    task: SimulationTask,
    itemId: string,
    epoch: number,
  ): ResultAsync<void, HostingError>;
  finishOrbCleanup(task: SimulationTask, orbId: string): ResultAsync<void, HostingError>;
}

export interface HostingDeps {
  readonly store: HostingStore;
  readonly bytes: HostedByteStore;
  readonly maxFileBytes?: number;
  /** At least the enclosing upload deadline; adapters may renew during long writes. */
  readonly uploadLeaseMs: number;
  /** Injected restart/process-local claim identity; never used as durable publication identity. */
  readonly nextClaimOwner: (task: SimulationTask) => string;
}

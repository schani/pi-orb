import type {
  HarnessSessionMetadata,
  HistoryRecord,
  MessageInputBlock,
  OrbState,
  PullHistoryResponse,
  RuntimeHealth,
  StopReason,
} from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import type { ResultAsync } from "neverthrow";
import type {
  AuthGateError,
  CommitPullError,
  OrbHostProviderError,
  PointerConflict,
  ProjectConflict,
  ProjectSecretPointerConflict,
  RuntimeClientError,
  SignerError,
  SigningKeyConflict,
  StateConflict,
  StoreError,
} from "./errors.ts";
import type {
  OrbDeletionRow,
  OrbMessageRow,
  OrbRow,
  ProjectDeletionProgress,
  ProjectRow,
} from "./orb.ts";

/** In-process adapter context; never serialized on the wire. */
export interface OperationContext {
  readonly signal: AbortSignal;
}

// ---------------------------------------------------------------------------
// Store

export interface CasTransitionParams {
  readonly orbId: string;
  readonly expectedStateVersion: number;
  readonly toState: OrbState;
  /** Wall-clock ms; becomes the new `state_changed_at`. */
  readonly now: number;
  readonly lastError?: string | null;
  readonly hostRef?: string | null;
  readonly checkoutCommit?: string | null;
  /** Set entering `stopping` (idle) and cleared on explicit stops/starts (docs/lifecycle.md). */
  readonly stopReason?: StopReason | null;
}

export interface CasUpdateFieldsParams {
  readonly orbId: string;
  readonly expectedStateVersion: number;
  readonly now: number;
  readonly hostRef?: string | null;
  readonly checkoutCommit?: string | null;
  readonly lastError?: string | null;
  readonly runtimeTokenHash?: string | null;
  readonly hostSpecFingerprint?: string | null;
  readonly hostSpecGeneration?: number | null;
  /**
   * Clear-only: retained discard evidence is dropped when a replacement
   * commits, so it cannot shadow a later incident (docs/compute-replacement.md).
   */
  readonly hostDiscardEvidence?: null;
}

export interface RecordHostDiscardStatusParams {
  readonly orbId: string;
  readonly throughIncarnation: number;
  readonly now: number;
  readonly evidence?: string | null;
  readonly error?: string | null;
}

export interface FailOrbAndRequestComputeDiscardParams {
  readonly orbId: string;
  readonly expectedStateVersion: number;
  readonly now: number;
  readonly lastError: string;
  /** Sanitized, size-bounded host evidence already available at the terminal decision. */
  readonly evidence?: string | null;
}

export interface FinalizeHostDiscardParams {
  readonly orbId: string;
  readonly expectedStateVersion: number;
  readonly throughIncarnation: number;
  readonly now: number;
}

export interface RequestHostSpecReplacementParams {
  readonly orbId: string;
  readonly expectedStateVersion: number;
  readonly desiredFingerprint: string;
  readonly configuredGeneration: number;
  /** Provider observation proved the durable stamp does not match the resource. */
  readonly force?: boolean;
  readonly now: number;
}

export type HostSpecReplacementOutcome =
  | { readonly type: "current"; readonly orb: OrbRow }
  | { readonly type: "requested"; readonly orb: OrbRow }
  | { readonly type: "declined"; readonly orb: OrbRow; readonly committedGeneration: number };

export interface RequestOrbDeletionParams {
  readonly orbId: string;
  readonly expectedStateVersion: number;
  readonly now: number;
  readonly cleanupAfter: number;
}

export interface RequestOrbArchiveParams {
  readonly orbId: string;
  readonly expectedStateVersion: number;
  readonly now: number;
  readonly cleanupAfter: number;
}

export interface CommitPullBatchParams {
  readonly orbId: string;
  /** Cursor read before the pull; commit only if it is still current. */
  readonly expectedCursor: string | null;
  readonly session: HarnessSessionMetadata;
  readonly records: readonly HistoryRecord[];
  readonly nextCursor: string;
  readonly nextHeadId: string | null;
}

/**
 * The single storage boundary of the control-plane domain (docs/stack.md).
 * Every mutation is transactional in the real adapter. Lifecycle writes use
 * `state_version` CAS; replication writes use cursor CAS; the two never touch
 * each other's correctness fields.
 */
export interface ControlPlaneStore {
  getProject(task: SimulationTask, projectId: string): ResultAsync<ProjectRow | null, StoreError>;
  listProjects(task: SimulationTask): ResultAsync<ProjectRow[], StoreError>;
  listProjectsInState(
    task: SimulationTask,
    state: "deleting",
  ): ResultAsync<ProjectRow[], StoreError>;
  insertProject(task: SimulationTask, project: ProjectRow): ResultAsync<ProjectRow, StoreError>;
  /** Updates only an active project, atomically fencing rename against deletion. */
  setProjectName(
    task: SimulationTask,
    params: { projectId: string; name: string; now: number },
  ): ResultAsync<ProjectRow | null, StoreError>;
  /** Atomically fences child creation and moves every child to permanent deletion. */
  requestProjectDeletion(
    task: SimulationTask,
    params: { projectId: string; now: number; cleanupAfter: number },
  ): ResultAsync<
    { project: ProjectRow; orbs: OrbRow[]; newlyRequested: boolean; repaired: number },
    StoreError | ProjectConflict
  >;
  getProjectDeletionProgress(
    task: SimulationTask,
    projectId: string,
  ): ResultAsync<ProjectDeletionProgress, StoreError | ProjectConflict>;
  finalizeProjectDeletion(
    task: SimulationTask,
    params: { projectId: string; expectedStateVersion: number },
  ): ResultAsync<void, StoreError | ProjectConflict>;

  getOrb(task: SimulationTask, orbId: string): ResultAsync<OrbRow | null, StoreError>;
  /** Bearer-token lookup for the runtime broker routes (indexed hash). */
  getOrbByRuntimeTokenHash(
    task: SimulationTask,
    tokenHash: string,
  ): ResultAsync<OrbRow | null, StoreError>;
  listOrbsByProject(task: SimulationTask, projectId: string): ResultAsync<OrbRow[], StoreError>;
  listOrbsInStates(
    task: SimulationTask,
    states: readonly OrbState[],
  ): ResultAsync<OrbRow[], StoreError>;
  /** Inserts only while the parent project is active, fencing create-vs-delete. */
  insertOrb(task: SimulationTask, orb: OrbRow): ResultAsync<OrbRow, StoreError | ProjectConflict>;
  setOrbName(
    task: SimulationTask,
    params: { orbId: string; name: string; now: number; onlyIfNull: boolean },
  ): ResultAsync<OrbRow | null, StoreError>;
  claimOrbAutoName(
    task: SimulationTask,
    params: { orbId: string; now: number; leaseUntil: number },
  ): ResultAsync<"claimed" | "already_named" | "in_progress" | "backoff", StoreError>;
  failOrbAutoName(
    task: SimulationTask,
    params: { orbId: string; now: number; nextAttemptAt: number },
  ): ResultAsync<void, StoreError>;

  /**
   * Durable send-anytime FIFO admission: inserts the message, records the wake
   * intent when the orb cannot take delivery now (`stopping`/`stopped`/
   * `failed`) together with the orb `state_version` it was admitted against,
   * and refreshes `last_busy_at`. It deliberately performs no lifecycle
   * transition — the reconciler's terminal backstop owns the single
   * message-driven transition (docs/lifecycle.md).
   */
  enqueueOrbMessage(
    task: SimulationTask,
    params: {
      orbId: string;
      messageId: string;
      content: readonly MessageInputBlock[];
      now: number;
    },
  ): ResultAsync<
    { message: OrbMessageRow; orb: OrbRow; duplicate: boolean },
    StoreError | StateConflict
  >;
  listOrbMessages(task: SimulationTask, orbId: string): ResultAsync<OrbMessageRow[], StoreError>;
  /** Atomically freezes all currently queued messages into the next FIFO delivery batch. */
  claimNextOrbMessageBatch(
    task: SimulationTask,
    params: { orbId: string; now: number },
  ): ResultAsync<OrbMessageRow[], StoreError>;
  /**
   * Record how the runtime admitted a batch. Replication may already have
   * marked the same rows `delivered` (the inbox record can be pulled before
   * this call lands), so the note applies its metadata to delivered rows too
   * and never downgrades their status (docs/runtime-protocol.md).
   */
  noteOrbMessageDelivery(
    task: SimulationTask,
    params: {
      orbId: string;
      messageIds: readonly string[];
      delivery: "turn" | "steer";
      operationId: string;
      now: number;
    },
  ): ResultAsync<void, StoreError>;
  /**
   * Terminal failure of one delivery batch: a runtime rejection no retry can
   * improve on. The rows leave the outstanding set, so later messages are
   * claimable, and keep the sanitized reason for the user.
   */
  failOrbMessageBatch(
    task: SimulationTask,
    params: {
      orbId: string;
      messageIds: readonly string[];
      lastError: string;
      now: number;
    },
  ): ResultAsync<void, StoreError>;
  clearOrbMessageAutoStart(
    task: SimulationTask,
    params: { orbId: string; now: number },
  ): ResultAsync<void, StoreError>;
  /**
   * The one message-driven lifecycle transition, in one transaction: enters
   * `starting` if — and only if — some outstanding message still carries a
   * wake intent that authorizes it in the orb's current state. From `stopped`
   * any outstanding intent wakes, whatever its position in the FIFO; from
   * `failed` only an intent admitted against the current `state_version` does,
   * so a new send retries a failed boot once while a stranded intent never
   * does. Returns null when no such intent is outstanding, so an explicit stop
   * linearized after the intent cannot be undone by a stale read
   * (docs/lifecycle.md).
   */
  casStartOrbForQueuedMessage(
    task: SimulationTask,
    params: { orbId: string; expectedStateVersion: number; now: number },
  ): ResultAsync<OrbRow | null, StoreError | StateConflict>;

  /** Atomically enter archiving and create its durable cleanup intent. */
  requestOrbArchive(
    task: SimulationTask,
    params: RequestOrbArchiveParams,
  ): ResultAsync<OrbRow, StoreError | StateConflict>;
  sealOrbArchive(
    task: SimulationTask,
    params: {
      orbId: string;
      expectedStateVersion: number;
      now: number;
      cursor: string | null;
      headId: string | null;
    },
  ): ResultAsync<void, StoreError | StateConflict>;
  finalizeOrbArchive(
    task: SimulationTask,
    params: { orbId: string; expectedStateVersion: number; now: number },
  ): ResultAsync<OrbRow, StoreError | StateConflict>;

  /** Atomically enter deleting and create or upgrade its durable cleanup intent. */
  requestOrbDeletion(
    task: SimulationTask,
    params: RequestOrbDeletionParams,
  ): ResultAsync<OrbRow, StoreError | StateConflict>;
  getOrbDeletion(
    task: SimulationTask,
    orbId: string,
  ): ResultAsync<OrbDeletionRow | null, StoreError>;
  recordOrbDeletionError(
    task: SimulationTask,
    params: { orbId: string; message: string | null; now: number },
  ): ResultAsync<void, StoreError>;
  /** Atomically removes history, orb row, and deletion tombstone. */
  finalizeOrbDeletion(
    task: SimulationTask,
    params: { orbId: string; expectedStateVersion: number },
  ): ResultAsync<void, StoreError | StateConflict>;

  /**
   * Atomically enters `failed`, revokes runtime authorization, and creates the
   * incarnation-bounded compute-discard intent (docs/compute-replacement.md).
   */
  failOrbAndRequestComputeDiscard(
    task: SimulationTask,
    params: FailOrbAndRequestComputeDiscardParams,
  ): ResultAsync<OrbRow, StoreError | StateConflict>;

  /** Persists bounded diagnosis/error only while the named discard intent is current. */
  recordHostDiscardStatus(
    task: SimulationTask,
    params: RecordHostDiscardStatusParams,
  ): ResultAsync<void, StoreError>;

  /** Clears a verified discard intent and advances compute identity above its fence. */
  finalizeHostDiscard(
    task: SimulationTask,
    params: FinalizeHostDiscardParams,
  ): ResultAsync<OrbRow, StoreError | StateConflict>;

  /** Atomically requests immutable replacement, fenced by the committed deploy generation. */
  requestHostSpecReplacement(
    task: SimulationTask,
    params: RequestHostSpecReplacementParams,
  ): ResultAsync<HostSpecReplacementOutcome, StoreError | StateConflict>;

  /** State transition: bumps `state_version`, sets `state_changed_at` to `now`. */
  casTransition(
    task: SimulationTask,
    params: CasTransitionParams,
  ): ResultAsync<OrbRow, StoreError | StateConflict>;

  /** Same-state field update: bumps `state_version`, leaves `state_changed_at` alone. */
  casUpdateFields(
    task: SimulationTask,
    params: CasUpdateFieldsParams,
  ): ResultAsync<OrbRow, StoreError | StateConflict>;

  /**
   * Monotone advisory update of `last_busy_at` (idle auto-stop, docs/lifecycle.md). Not a
   * correctness field: no state_version bump, so it can never conflict with
   * lifecycle CAS or replication cursor writes. `now` older than the stored
   * value is a no-op.
   */
  touchLastBusy(
    task: SimulationTask,
    params: { orbId: string; now: number },
  ): ResultAsync<void, StoreError>;

  /**
   * Claims the orb's mint rate-limit slot: one atomic conditional write that
   * moves `last_mint_at` to `at` only when the previous mint is at least
   * `minIntervalMs` old (docs/workload-identity.md). Reading the floor and
   * then advancing it would let N concurrent requests all pass the check, so
   * the claim *is* the check — of any number of racing callers exactly one
   * wins. Like `touchLastBusy` it is CAS-free: no `state_version` bump and no
   * `state_changed_at` move, so it can never conflict with lifecycle CAS.
   *
   * The floor only moves forward, since a claim is admitted only from strictly
   * below it. An orb id that resolves to no row cannot be throttled, so it is
   * reported as not claimed with the full interval: the mint path calls this
   * only after a bearer resolved to an orb, and denying is the fail-closed
   * answer if that orb vanished in between.
   */
  claimMintSlot(
    task: SimulationTask,
    params: { orbId: string; at: number; minIntervalMs: number },
  ): ResultAsync<MintSlotClaim, StoreError>;

  /**
   * Same-state re-entry with a fresh `state_changed_at` (OAuth completion,
   * docs/lifecycle.md): user login time never consumes the create/start deadline.
   */
  casReenterState(
    task: SimulationTask,
    params: { orbId: string; expectedStateVersion: number; now: number },
  ): ResultAsync<OrbRow, StoreError | StateConflict>;

  /**
   * One transaction (docs/history-replication.md): verify/initialize immutable session
   * metadata, insert records (identical duplicates allowed, conflicts are
   * integrity errors), advance `replication_cursor` via compare-and-swap and
   * update `replicated_head_id`.
   */
  commitPullBatch(
    task: SimulationTask,
    params: CommitPullBatchParams,
  ): ResultAsync<OrbRow, CommitPullError>;

  /** Verify or initialize session metadata without advancing the cursor. */
  initOrVerifySession(
    task: SimulationTask,
    orbId: string,
    session: HarnessSessionMetadata,
  ): ResultAsync<void, StoreError | import("./errors.ts").ReplicationIntegrityError>;

  /** Consistent snapshot for the history API and live handoff (docs/history-replication.md). */
  readHistorySnapshot(
    task: SimulationTask,
    orbId: string,
  ): ResultAsync<
    {
      session: HarnessSessionMetadata | null;
      cursor: string | null;
      headId: string | null;
      records: HistoryRecord[];
    },
    StoreError
  >;
}

// ---------------------------------------------------------------------------
// Host provider (docs/host-provider.md)

export type OrbHostState = "starting" | "running" | "stopping" | "stopped" | "failed";

export interface OrbHostRef {
  readonly provider: string;
  readonly resourceId: string;
}

export interface OrbHostObservation {
  readonly ref: OrbHostRef;
  readonly orbId: string;
  /** Incarnation stamped on the observed resource; legacy unstamped compute is 0. */
  readonly incarnation: number;
  /** Immutable specification stamped on this resource; legacy resources report null. */
  readonly specFingerprint: string | null;
  readonly state: OrbHostState;
  /** Ephemeral observation; never authoritative persisted state. */
  readonly runtimeAddress?: { baseUrl: string };
  readonly failure?: { code: string; message: string };
}

export interface ProvisionOrbHostRequest {
  readonly orbId: string;
  readonly incarnation: number;
  readonly bootstrap: { repositoryUrl: string };
}

export interface StartOrbHostRequest {
  readonly ref: OrbHostRef;
  readonly expectedIncarnation: number;
  /**
   * The durable committed fingerprint, or null for a legacy row that predates
   * spec stamping. Providers conflict on any stamp difference; a null
   * expectation matches only an unstamped legacy resource, so pre-migration
   * compute can still restart in place until its next ordinary Start replaces
   * it (docs/compute-replacement.md).
   */
  readonly expectedSpecFingerprint: string | null;
}

/**
 * Provision outcome. `runtimeTokenHash` is the SHA-256 of the runtime token
 * the host *actually carries* — minted fresh when the provider created the
 * host, read back from the host's delivery channel (container env, instance
 * metadata) when an existing host was found. The control plane commits this
 * observed hash; it never needs the plaintext (docs/credentials.md).
 */
export interface ProvisionedOrbHost {
  readonly ref: OrbHostRef;
  readonly incarnation: number;
  readonly runtimeTokenHash: string;
  readonly specFingerprint: string;
  readonly specGeneration: number;
}

export interface OrbHostProvider {
  readonly kind: string;
  /** Deploy-monotone authority used only to fence specification replacement. */
  readonly specGeneration: number;
  /** Pure fingerprint of every non-secret input that fixes an incarnation's launch contract. */
  desiredSpecFingerprint(input: { readonly orbId: string; readonly repositoryUrl: string }): string;
  /** Idempotent by orbId. */
  provision(
    task: SimulationTask,
    request: ProvisionOrbHostRequest,
    context: OperationContext,
  ): ResultAsync<ProvisionedOrbHost, OrbHostProviderError>;
  /** Idempotent. */
  start(
    task: SimulationTask,
    request: StartOrbHostRequest,
    context: OperationContext,
  ): ResultAsync<void, OrbHostProviderError>;
  /** Gracefully stops compute while retaining its filesystem. Idempotent. */
  stop(
    task: SimulationTask,
    ref: OrbHostRef,
    context: OperationContext,
  ): ResultAsync<void, OrbHostProviderError>;
  /**
   * Removes disposable compute through an incarnation fence while preserving
   * authoritative workspace and tailnet identity. Absence is success.
   */
  discardCompute(
    task: SimulationTask,
    request: { orbId: string; throughIncarnation: number },
    context: OperationContext,
  ): ResultAsync<void, OrbHostProviderError>;
  /** Permanently removes compute and authoritative storage by orb identity. Idempotent. */
  destroy(
    task: SimulationTask,
    orbId: string,
    context: OperationContext,
  ): ResultAsync<void, OrbHostProviderError>;
  /** Returns null only on definitive absence; uncertainty is an Err. */
  observe(
    task: SimulationTask,
    ref: OrbHostRef,
    context: OperationContext,
  ): ResultAsync<OrbHostObservation | null, OrbHostProviderError>;
  listManagedHosts(
    task: SimulationTask,
    context: OperationContext,
  ): ResultAsync<OrbHostObservation[], OrbHostProviderError>;
  /**
   * Optional cheap host-side evidence for an unreachable runtime (e.g. GCE
   * guest-attribute startup markers). Null when nothing is known.
   */
  diagnose?(
    task: SimulationTask,
    ref: OrbHostRef,
    context: OperationContext,
  ): ResultAsync<string | null, OrbHostProviderError>;
}

// ---------------------------------------------------------------------------
// Runtime client (docs/runtime-protocol.md)

export interface DeliverMessageClientRequest {
  readonly baseUrl: string;
  readonly messageId: string;
  readonly messageIds: readonly string[];
  readonly content: readonly MessageInputBlock[];
}

export interface PullHistoryClientRequest {
  readonly baseUrl: string;
  readonly after: string | null;
  readonly limit: number;
}

export interface OrbRuntimeClient {
  deliverMessage(
    task: SimulationTask,
    request: DeliverMessageClientRequest,
    context: OperationContext,
  ): ResultAsync<import("@pi-orb/protocol").DeliverOrbMessageResponse, RuntimeClientError>;
  health(
    task: SimulationTask,
    baseUrl: string,
    context: OperationContext,
  ): ResultAsync<RuntimeHealth, RuntimeClientError>;
  pullHistory(
    task: SimulationTask,
    request: PullHistoryClientRequest,
    context: OperationContext,
  ): ResultAsync<PullHistoryResponse, RuntimeClientError>;
}

// ---------------------------------------------------------------------------
// Auth gate (docs/credentials.md)

/** Which upstream a device challenge belongs to (drives the UI label). */
export type ChallengeProvider = "openai-codex" | "github";

export interface DeviceChallenge {
  readonly provider: ChallengeProvider;
  readonly verificationUri: string;
  readonly userCode: string;
  /** Wall-clock ms. */
  readonly expiresAt: number;
}

export type AuthResolution =
  | { readonly status: "ok" }
  /** One global device flow is running; blocked orbs share this challenge. */
  | { readonly status: "pending"; readonly challenge: DeviceChallenge }
  | { readonly status: "failed"; readonly message: string; readonly retryable: boolean };

export interface AuthGate {
  /**
   * Resolve/refresh the Codex credential; if missing, ensure exactly one
   * global device-code login flow is running and report its challenge.
   */
  ensureAuth(task: SimulationTask): ResultAsync<AuthResolution, AuthGateError>;
}

// ---------------------------------------------------------------------------
// Project secrets (docs/credentials.md)

export interface StoredProjectSecretBundle {
  readonly projectId: string;
  readonly revision: number;
  readonly values: Readonly<Record<string, string>>;
}

export interface ProjectSecretPointerRow {
  readonly projectId: string;
  readonly rowVersion: number;
  readonly revision: number;
  /** Name -> wall-clock ms of the latest write. Contains no values. */
  readonly entries: Readonly<Record<string, number>>;
  readonly secretVersion: string;
  readonly updatedAt: number;
}

export type ProjectSecretPointerWrite = Omit<ProjectSecretPointerRow, "projectId" | "rowVersion">;

export interface ProjectSecretPointerStore {
  readProjectSecretPointer(
    task: SimulationTask,
    projectId: string,
  ): ResultAsync<ProjectSecretPointerRow | null, StoreError | ProjectConflict>;
  /** CAS write allowed only while the parent project is active. */
  casWriteProjectSecretPointer(
    task: SimulationTask,
    projectId: string,
    expectedRowVersion: number | null,
    next: ProjectSecretPointerWrite,
  ): ResultAsync<
    ProjectSecretPointerRow,
    StoreError | ProjectConflict | ProjectSecretPointerConflict
  >;
  /** Removes metadata only while the parent project is durably deleting. */
  deleteProjectSecretPointer(
    task: SimulationTask,
    projectId: string,
  ): ResultAsync<void, StoreError | ProjectConflict>;
}

export interface ProjectSecretsDeps {
  readonly pointers: ProjectSecretPointerStore;
  readonly secrets: CredentialSecretStore;
}

// ---------------------------------------------------------------------------
// Credential broker (docs/credentials.md)

/**
 * The durable credential pointer. Lives in PostgreSQL; holds no secret
 * material. `rowVersion` is the CAS fence and bumps on every write;
 * `generation` identifies the credential and bumps only when the credential
 * itself changes (login, refresh, clear).
 */
export interface CredentialPointerRow {
  readonly provider: string;
  readonly rowVersion: number;
  readonly generation: number;
  /** Secret-store version holding the credential; null = no usable credential. */
  readonly secretVersion: string | null;
  /** Refresh-coalescing lease, wall-clock ms; 0 = no lease. */
  readonly refreshLeaseUntil: number;
  /** Wall-clock ms of the last refresh attempt that reached the upstream. */
  readonly lastRefreshAt: number;
}

export type CredentialPointerWrite = Omit<CredentialPointerRow, "provider" | "rowVersion">;

export interface CredentialPointerStore {
  readPointer(
    task: SimulationTask,
    provider: string,
  ): ResultAsync<CredentialPointerRow | null, StoreError>;
  /**
   * Compare-and-swap write. `expectedRowVersion: null` means the row must not
   * exist yet (insert). Every fenced mutation goes through here.
   */
  casWritePointer(
    task: SimulationTask,
    provider: string,
    expectedRowVersion: number | null,
    next: CredentialPointerWrite,
  ): ResultAsync<CredentialPointerRow, StoreError | PointerConflict>;
}

/**
 * The stored Codex credential. Exists only in the secret store (file locally,
 * Secret Manager in the cloud) and in broker memory during a mutation — never
 * in PostgreSQL, never in an orb.
 */
export interface StoredCredential {
  readonly access: string;
  readonly refresh: string;
  readonly accountId: string;
  /** Wall-clock ms. */
  readonly expiresAt: number;
}

/**
 * The issuer's private signing key (docs/workload-identity.md). Like a stored
 * credential it exists only in the secret store, addressed by exact version,
 * and never in PostgreSQL, an orb, an image, or a log. Only the public half
 * lives in `oidc_signing_keys`.
 */
export interface StoredSigningKey {
  /** PKCS#8 PEM. */
  readonly privateKeyPem: string;
}

/**
 * What the secret store holds. Each consumer writes and reads back exactly one
 * of these shapes under its own provider name, so the store itself stays a
 * dumb immutable-version keeper with no idea what a version means.
 */
export type StoredSecret = StoredCredential | StoredSigningKey | StoredProjectSecretBundle;

export interface CredentialSecretStore {
  /** Creates a new immutable version and returns its identifier. */
  writeSecret<T extends StoredSecret = StoredCredential>(
    task: SimulationTask,
    provider: string,
    credential: T,
  ): ResultAsync<{ version: string }, StoreError>;
  /** Reads one exact version; null when it does not exist or was destroyed. */
  readSecret<T extends StoredSecret = StoredCredential>(
    task: SimulationTask,
    provider: string,
    version: string,
  ): ResultAsync<T | null, StoreError>;
  /** Lists all live immutable versions under one provider namespace. */
  listSecretVersions(task: SimulationTask, provider: string): ResultAsync<string[], StoreError>;
  /** Best-effort cleanup of a superseded version. */
  destroySecret(
    task: SimulationTask,
    provider: string,
    version: string,
  ): ResultAsync<void, StoreError>;
}

/** Performs the actual upstream OAuth refresh (rotates the refresh token). */
export interface UpstreamRefresher {
  refresh(
    task: SimulationTask,
    credential: StoredCredential,
    context: OperationContext,
  ): ResultAsync<StoredCredential, import("./errors.ts").UpstreamRefreshError>;
}

export interface BrokerDeps {
  readonly pointers: CredentialPointerStore;
  readonly secrets: CredentialSecretStore;
  /** One refresher per provider; a provider with no entry cannot refresh. */
  readonly upstreams: Readonly<Record<string, UpstreamRefresher>>;
  readonly constants: import("./constants.ts").BrokerConstants;
}

// ---------------------------------------------------------------------------
// Workload identity (docs/workload-identity.md)

/** Outcome of one atomic `claimMintSlot` write. */
export type MintSlotClaim =
  | { readonly claimed: true }
  | { readonly claimed: false; readonly retryAfterMs: number };

/**
 * The claim set of one issued identity token (docs/workload-identity.md). Every
 * field is derived from the orb row and the deployment's configuration — none
 * of it is ever supplied by the caller, which asks only for an audience and a
 * lifetime. `iat`/`exp` are unix *seconds*, as JWT requires, while the rest of
 * the control plane measures wall-clock milliseconds.
 */
export interface IdTokenClaims {
  readonly iss: string;
  readonly aud: string;
  /** The orb ID: compact, immutable, and stable across compute replacement. */
  readonly sub: string;
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
  readonly project_id: string;
  readonly orb_id: string;
  readonly host_incarnation: number;
  /** Distinguishes workload exchange tokens from future token classes. */
  readonly token_use: "exchanged";
}

/**
 * Signs identity tokens. The mint path never sees key material — only the
 * finished JWT and the `kid` it was signed with, so a caller can be told which
 * published key verifies it. Key *management* is the one place that does
 * handle a private key, because it has to hand a freshly generated one to the
 * secret store (`domain/signing-keys.ts`).
 */
export interface TokenSigner {
  signIdToken(
    task: SimulationTask,
    claims: IdTokenClaims,
  ): ResultAsync<{ jwt: string; kid: string }, SignerError>;
}

/**
 * Entropy for `jti`. Separate from the signer because it must be simulated
 * independently: uniqueness across concurrent mints is a scheduling property.
 */
export interface MintIdSource {
  newJti(task: SimulationTask): string;
}

/** Everything `mintIdToken` needs; the mint's counterpart to `BrokerDeps`. */
export interface MintDeps {
  readonly store: ControlPlaneStore;
  readonly signer: TokenSigner;
  readonly mintIds: MintIdSource;
  readonly constants: import("./constants.ts").IssuerConstants;
  /**
   * Per-process edge dedup for denial log lines. Lives on the deps rather than
   * inside `mintIdToken` because it is state that must survive across requests
   * — and because a scenario can then assert on the edges it produced.
   */
  readonly denials: import("./workload-identity.ts").MintDenialLog;
  /** The deployment's public issuer URL, validated at boot, never from a header. */
  readonly issuerUrl: string;
}

export type SigningKeyState = "pending" | "active" | "retired";

/**
 * The public half of one issuer signing key. Nothing here is secret — JWKS is
 * served straight from these rows — while the private key exists only in the
 * secret store, addressed by the exact `secretVersion`. `rowVersion` is the
 * CAS fence and bumps on every state change.
 */
export interface SigningKeyRow {
  readonly kid: string;
  readonly secretVersion: string;
  /** RFC 7517 JWK of the public half; opaque to the store. */
  readonly publicJwk: unknown;
  readonly state: SigningKeyState;
  /** Wall-clock ms. Set exactly when the state requires it. */
  readonly createdAt: number;
  readonly activatedAt: number | null;
  readonly retiredAt: number | null;
  readonly rowVersion: number;
}

export interface CasSigningKeyStateParams {
  readonly kid: string;
  readonly expectedRowVersion: number;
  readonly state: SigningKeyState;
  /** Required when entering `active`; the row keeps its value when omitted. */
  readonly activatedAt?: number;
  /** Required when entering `retired`. */
  readonly retiredAt?: number;
}

/** A freshly generated key, before anything durable knows about it. */
export interface GeneratedSigningKey {
  /** The RFC 7638 thumbprint of the public JWK: derivable by any verifier. */
  readonly kid: string;
  /** PKCS#8 PEM, on its way to the secret store and nowhere else. */
  readonly privateKeyPem: string;
  /** The public JWK as JWKS will publish it; opaque to the domain. */
  readonly publicJwk: unknown;
}

/**
 * Makes signing keys. Separate from `TokenSigner` because key generation is
 * expensive, happens on ops paths rather than per mint, and must be replaced
 * by a deterministic fake in simulation — real RSA generation in a DST loop
 * would be neither deterministic nor fast.
 */
export interface SigningKeyGenerator {
  generate(task: SimulationTask): ResultAsync<GeneratedSigningKey, SignerError>;
}

export interface SigningKeyStore {
  /** Every key, oldest first: JWKS publishes the active one plus retiring ones. */
  listSigningKeys(task: SimulationTask): ResultAsync<SigningKeyRow[], StoreError>;
  /**
   * Inserts a key. A duplicate `kid` and a second `active` key are both
   * refused by the schema, so they surface as a `corruption` StoreError rather
   * than a conflict a caller could retry into.
   */
  insertSigningKey(
    task: SimulationTask,
    row: SigningKeyRow,
  ): ResultAsync<SigningKeyRow, StoreError>;
  /** Fenced state change: activation and retirement never race each other. */
  casSigningKeyState(
    task: SimulationTask,
    params: CasSigningKeyStateParams,
  ): ResultAsync<SigningKeyRow, StoreError | SigningKeyConflict>;
}

/**
 * What reading the *current* signing material needs: the published rows plus
 * the secret version one of them points at. Narrower than `SigningKeyDeps` so
 * the signing path cannot generate a key by accident.
 */
export interface SigningKeyMaterialDeps {
  readonly keys: SigningKeyStore;
  readonly secrets: CredentialSecretStore;
  /** `signingKeyMaterialTtlMs` bounds how long read material may be reused. */
  readonly constants: import("./constants.ts").IssuerConstants;
}

/**
 * What serving JWKS needs. Deliberately without a secret store: the published
 * key set contains no secret, so the issuer role never gets secret access.
 */
export interface JwksDeps {
  readonly keys: SigningKeyStore;
  readonly constants: import("./constants.ts").IssuerConstants;
}

/** Everything key management needs (`domain/signing-keys.ts`). */
export interface SigningKeyDeps extends SigningKeyMaterialDeps, JwksDeps {
  readonly generator: SigningKeyGenerator;
}

// ---------------------------------------------------------------------------

export interface OrbNameGeneratorError {
  readonly type: "orb_name_generation_error";
  readonly message: string;
  readonly retryable: boolean;
}

export interface OrbNameGenerator {
  generate(
    task: SimulationTask,
    input: {
      projectName: string;
      repositoryUrl: string;
      message: string;
      readme: string | null;
    },
    context: OperationContext,
  ): ResultAsync<string, OrbNameGeneratorError>;
}

export interface OrbResourceCleaner {
  cleanupOrb(
    task: SimulationTask,
    orbId: string,
    context: OperationContext,
  ): ResultAsync<void, { readonly message: string; readonly retryable: boolean }>;
}

export interface ControlPlaneDeps {
  readonly store: ControlPlaneStore;
  readonly hostProvider: OrbHostProvider;
  readonly resourceCleaner: OrbResourceCleaner;
  readonly runtimeClient: OrbRuntimeClient;
  readonly authGate: AuthGate;
  readonly nameGenerator: OrbNameGenerator;
  readonly nameLeaseMs: number;
  readonly control: import("./control-state.ts").ControlState;
  readonly constants: import("./constants.ts").LifecycleConstants;
  readonly projectSecrets: ProjectSecretsDeps;
}

import type {
  HarnessSessionMetadata,
  HistoryRecord,
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
  RuntimeClientError,
  StateConflict,
  StoreError,
} from "./errors.ts";
import type { OrbRow, ProjectRow } from "./orb.ts";

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
  /** Set entering `stopping` (idle) and cleared on explicit stops/starts (§3.4). */
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
 * The single storage boundary of the control-plane domain (DESIGN.md §17.5).
 * Every mutation is transactional in the real adapter. Lifecycle writes use
 * `state_version` CAS; replication writes use cursor CAS; the two never touch
 * each other's correctness fields.
 */
export interface ControlPlaneStore {
  getProject(task: SimulationTask, projectId: string): ResultAsync<ProjectRow | null, StoreError>;
  listProjects(task: SimulationTask): ResultAsync<ProjectRow[], StoreError>;
  insertProject(task: SimulationTask, project: ProjectRow): ResultAsync<ProjectRow, StoreError>;

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
  insertOrb(task: SimulationTask, orb: OrbRow): ResultAsync<OrbRow, StoreError>;

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
   * Monotone advisory update of `last_busy_at` (idle auto-stop, §3.4). Not a
   * correctness field: no state_version bump, so it can never conflict with
   * lifecycle CAS or replication cursor writes. `now` older than the stored
   * value is a no-op.
   */
  touchLastBusy(
    task: SimulationTask,
    params: { orbId: string; now: number },
  ): ResultAsync<void, StoreError>;

  /**
   * Same-state re-entry with a fresh `state_changed_at` (OAuth completion,
   * DESIGN.md §5.2): user login time never consumes the create/start deadline.
   */
  casReenterState(
    task: SimulationTask,
    params: { orbId: string; expectedStateVersion: number; now: number },
  ): ResultAsync<OrbRow, StoreError | StateConflict>;

  /**
   * One transaction (DESIGN.md §8.6): verify/initialize immutable session
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

  /** Consistent snapshot for the history API and live handoff (DESIGN.md §8.3). */
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
// Host provider (DESIGN.md §5)

export type OrbHostState = "starting" | "running" | "stopping" | "stopped" | "failed";

export interface OrbHostRef {
  readonly provider: string;
  readonly resourceId: string;
}

export interface OrbHostObservation {
  readonly ref: OrbHostRef;
  readonly orbId: string;
  readonly state: OrbHostState;
  /** Ephemeral observation; never authoritative persisted state. */
  readonly runtimeAddress?: { baseUrl: string };
  readonly failure?: { code: string; message: string };
}

export interface ProvisionOrbHostRequest {
  readonly orbId: string;
  readonly bootstrap: { repositoryUrl: string };
}

/**
 * Provision outcome. `runtimeTokenHash` is the SHA-256 of the runtime token
 * the host *actually carries* — minted fresh when the provider created the
 * host, read back from the host's delivery channel (container env, instance
 * metadata) when an existing host was found. The control plane commits this
 * observed hash; it never needs the plaintext (DESIGN.md §15.1).
 */
export interface ProvisionedOrbHost {
  readonly ref: OrbHostRef;
  readonly runtimeTokenHash: string;
}

export interface OrbHostProvider {
  readonly kind: string;
  /** Idempotent by orbId. */
  provision(
    task: SimulationTask,
    request: ProvisionOrbHostRequest,
    context: OperationContext,
  ): ResultAsync<ProvisionedOrbHost, OrbHostProviderError>;
  /** Idempotent. */
  start(
    task: SimulationTask,
    ref: OrbHostRef,
    context: OperationContext,
  ): ResultAsync<void, OrbHostProviderError>;
  /** Gracefully stops compute while retaining its filesystem. Idempotent. */
  stop(
    task: SimulationTask,
    ref: OrbHostRef,
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
// Runtime client (DESIGN.md §6)

export interface PullHistoryClientRequest {
  readonly baseUrl: string;
  readonly after: string | null;
  readonly limit: number;
}

export interface OrbRuntimeClient {
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
// Auth gate (DESIGN.md §15.1)

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
// Credential broker (DESIGN.md §15.1)

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

export interface CredentialSecretStore {
  /** Creates a new immutable version and returns its identifier. */
  writeSecret(
    task: SimulationTask,
    provider: string,
    credential: StoredCredential,
  ): ResultAsync<{ version: string }, StoreError>;
  /** Reads one exact version; null when it does not exist or was destroyed. */
  readSecret(
    task: SimulationTask,
    provider: string,
    version: string,
  ): ResultAsync<StoredCredential | null, StoreError>;
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

export interface ControlPlaneDeps {
  readonly store: ControlPlaneStore;
  readonly hostProvider: OrbHostProvider;
  readonly runtimeClient: OrbRuntimeClient;
  readonly authGate: AuthGate;
  readonly control: import("./control-state.ts").ControlState;
  readonly constants: import("./constants.ts").LifecycleConstants;
}

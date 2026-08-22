import type { HarnessSessionMetadata, HistoryRecord, OrbState } from "@pi-orb/protocol";
import { ApplicationFailure, type SimulationTask } from "determined";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import type {
  CommitPullError,
  MintFailureCode,
  ProjectConflict,
  ReplicationIntegrityError,
  StateConflict,
  StoreError,
} from "../domain/errors.ts";
import { jsonEqual } from "../domain/json-equal.ts";
import type { OrbDeletionRow, OrbMessageRow, OrbRow, ProjectRow } from "../domain/orb.ts";
import type {
  CasTransitionParams,
  CasUpdateFieldsParams,
  CommitPullBatchParams,
  ControlPlaneStore,
  FailOrbAndRequestComputeDiscardParams,
  FinalizeHostDiscardParams,
  MintSlotClaim,
  RecordHostDiscardStatusParams,
  RequestHostSpecReplacementParams,
  RequestOrbArchiveParams,
  RequestOrbDeletionParams,
} from "../domain/ports.ts";
import { FAILPOINTS } from "./failpoints.ts";

/** Store operations that can be scripted to fail deterministically. */
export type InvariantOperation = "getOrb" | "getOrbByRuntimeTokenHash" | "enqueueOrbMessage";

interface OrbReplica {
  records: Map<string, HistoryRecord>;
  order: string[];
}

const unavailable = (message: string): StoreError => ({
  type: "store_error",
  code: "unavailable",
  message,
  retryable: true,
});

/**
 * A deterministic store bug: bad SQL or a parameter the driver cannot encode
 * (docs/postmortems/2026-08-11-orb-message-jsonb-param-encoding.md). Scripted,
 * not injectable through a failpoint, because it is not an outage: nothing
 * about the schedule makes it appear or clear.
 */
const invariant = (message: string): StoreError => ({
  type: "store_error",
  code: "invariant",
  message,
  retryable: false,
});

/**
 * Deterministic in-memory `ControlPlaneStore` with the same CAS semantics the
 * PostgreSQL adapter must implement. Latency comes from `task.sleep`, failures
 * from named failpoints, so schedules and outages replay exactly.
 */
export class InMemoryControlPlaneStore implements ControlPlaneStore {
  private readonly projects = new Map<string, ProjectRow>();
  private readonly orbs = new Map<string, OrbRow>();
  private readonly replicas = new Map<string, OrbReplica>();
  private readonly deletions = new Map<string, OrbDeletionRow>();
  private readonly messages = new Map<string, OrbMessageRow[]>();
  private nextMessageOrdinal = 1;
  /** Remaining scripted failures of `clearOrbMessageAutoStart`. */
  private clearAutoStartFailures = 0;
  /** Crash window after provider absence verification but before fence finalization. */
  private hostDiscardFinalizeFailures = 0;
  /** External replacement provision landed, but committing its ref/token fails. */
  private hostReplacementCommitFailures = 0;
  /** Operations scripted to fail with a deterministic `invariant` store error. */
  private readonly invariantOperations = new Set<InvariantOperation>();
  /** Gate the next `noteOrbMessageDelivery` until this predicate holds. */
  private noteDeliveryHold: (() => boolean) | null = null;

  private readonly maxLatencyMs: number;

  constructor(maxLatencyMs: number = 5) {
    this.maxLatencyMs = maxLatencyMs;
  }

  // -- test helpers ---------------------------------------------------------

  seedProject(project: ProjectRow): void {
    this.projects.set(project.id, project);
  }

  seedOrb(orb: OrbRow): void {
    this.orbs.set(orb.id, orb);
  }

  projectSnapshot(projectId: string): ProjectRow | null {
    return this.projects.get(projectId) ?? null;
  }

  orbSnapshot(orbId: string): OrbRow | null {
    return this.orbs.get(orbId) ?? null;
  }

  deletionSnapshot(orbId: string): OrbDeletionRow | null {
    return this.deletions.get(orbId) ?? null;
  }

  messageSnapshots(orbId: string): OrbMessageRow[] {
    return [...(this.messages.get(orbId) ?? [])];
  }

  failNextHostDiscardFinalizations(count: number): void {
    this.hostDiscardFinalizeFailures = count;
  }

  failNextHostReplacementCommits(count: number): void {
    this.hostReplacementCommitFailures = count;
  }

  /**
   * Fail the next `count` calls to `clearOrbMessageAutoStart` with a retryable
   * store error — the store blip that can strand a message's wake intent.
   */
  failNextClearOrbMessageAutoStart(count: number): void {
    this.clearAutoStartFailures = count;
  }

  /**
   * Make `operation` fail with an `invariant` store error until cleared: the
   * shape of a wrong-SQL/wrong-parameter bug, which no retry can survive.
   */
  failWithInvariant(operation: InvariantOperation): void {
    this.invariantOperations.add(operation);
  }

  /**
   * Hold the next `noteOrbMessageDelivery` until `until` holds — the schedule
   * where replication commits the inbox record (marking the rows `delivered`)
   * before the delivery note lands, which no probability can be relied on to
   * produce.
   */
  holdNextNoteOrbMessageDelivery(until: () => boolean): void {
    this.noteDeliveryHold = until;
  }

  replicaRecords(orbId: string): HistoryRecord[] {
    const replica = this.replicas.get(orbId);
    if (replica === undefined) return [];
    return replica.order.map((id) => {
      const record = replica.records.get(id);
      if (record === undefined) throw new Error(`replica order references missing ${id}`);
      return record;
    });
  }

  // -- plumbing -------------------------------------------------------------

  private scriptedInvariant(operation: InvariantOperation): StoreError | null {
    return this.invariantOperations.has(operation)
      ? invariant(`${operation}: parameter $3 is a bare JavaScript array`)
      : null;
  }

  private access<T>(
    task: SimulationTask,
    failpoint: string,
    reason: string,
    f: () => T,
  ): ResultAsync<T, StoreError> {
    const run = async (): Promise<T> => {
      await task.sleep(1 + task.random(`store latency: ${reason}`) * this.maxLatencyMs, reason);
      await task.failpoint(failpoint, reason);
      return f();
    };
    return ResultAsync.fromPromise(run(), (error) => {
      if (error instanceof ApplicationFailure) return unavailable(`${reason}: ${error.message}`);
      return task.abortSimulation(error);
    });
  }

  /** Deterministic gate for a scripted hold; a no-op when nothing is held. */
  private holdUntil(
    task: SimulationTask,
    until: (() => boolean) | null,
    reason: string,
  ): ResultAsync<void, StoreError> {
    if (until === null) return okAsync(undefined);
    const run = async (): Promise<void> => {
      // Bounded so a predicate the scenario never satisfies fails the
      // assertion it was written for instead of spinning forever.
      for (let attempt = 0; attempt < 2_000 && !until(); attempt++) {
        await task.sleep(10, reason);
      }
    };
    return ResultAsync.fromPromise(run(), (error) => task.abortSimulation(error));
  }

  private replicaOf(orbId: string): OrbReplica {
    let replica = this.replicas.get(orbId);
    if (replica === undefined) {
      replica = { records: new Map(), order: [] };
      this.replicas.set(orbId, replica);
    }
    return replica;
  }

  // -- projects/orbs --------------------------------------------------------

  getProject(task: SimulationTask, projectId: string): ResultAsync<ProjectRow | null, StoreError> {
    return this.access(task, FAILPOINTS.storeRead, "get project", () => {
      return this.projects.get(projectId) ?? null;
    });
  }

  listProjects(task: SimulationTask): ResultAsync<ProjectRow[], StoreError> {
    return this.access(task, FAILPOINTS.storeRead, "list projects", () => [
      ...this.projects.values(),
    ]);
  }

  listProjectsInState(
    task: SimulationTask,
    state: "deleting",
  ): ResultAsync<ProjectRow[], StoreError> {
    return this.access(task, FAILPOINTS.storeRead, "list deleting projects", () =>
      [...this.projects.values()].filter((project) => project.state === state),
    );
  }

  insertProject(task: SimulationTask, project: ProjectRow): ResultAsync<ProjectRow, StoreError> {
    return this.access(task, FAILPOINTS.storeWrite, "insert project", () => {
      this.projects.set(project.id, project);
      return project;
    });
  }

  setProjectName(
    task: SimulationTask,
    params: { projectId: string; name: string; now: number },
  ): ResultAsync<ProjectRow | null, StoreError> {
    return this.access(task, FAILPOINTS.storeWrite, "set project name", () => {
      const project = this.projects.get(params.projectId);
      if (project === undefined || project.state !== "active") return null;
      const updated = { ...project, name: params.name, updatedAt: params.now };
      this.projects.set(project.id, updated);
      return updated;
    });
  }

  requestProjectDeletion(
    task: SimulationTask,
    params: { projectId: string; now: number; cleanupAfter: number },
  ): ResultAsync<
    { project: ProjectRow; orbs: OrbRow[]; newlyRequested: boolean; repaired: number },
    StoreError | ProjectConflict
  > {
    return this.access(task, FAILPOINTS.storeWrite, "request project deletion", () => {
      const project = this.projects.get(params.projectId);
      if (project === undefined) return { conflict: "not_found" as const };
      const children = [...this.orbs.values()].filter((orb) => orb.projectId === params.projectId);
      const newlyRequested = project.state === "active";
      const repaired = children.filter((orb) => {
        const intent = this.deletions.get(orb.id);
        return orb.state !== "deleting" || intent === undefined || intent.kind !== "delete";
      }).length;
      const updatedProject: ProjectRow = newlyRequested
        ? {
            ...project,
            state: "deleting",
            stateVersion: project.stateVersion + 1,
            deletionRequestedAt: params.now,
            deletionInitialOrbCount: children.length,
            updatedAt: params.now,
          }
        : project;
      this.projects.set(project.id, updatedProject);
      const updatedOrbs: OrbRow[] = [];
      for (const orb of children) {
        const updated: OrbRow =
          orb.state === "deleting"
            ? orb
            : {
                ...orb,
                state: "deleting",
                stateVersion: orb.stateVersion + 1,
                stateChangedAt: params.now,
                updatedAt: params.now,
                lastError: null,
                stopReason: null,
                autoNameLeaseUntil: null,
                autoNameNextAttemptAt: null,
              };
        this.orbs.set(orb.id, updated);
        const existing = this.deletions.get(orb.id);
        this.deletions.set(orb.id, {
          orbId: orb.id,
          hostKind: orb.hostKind,
          kind: "delete",
          requestedAt: existing?.requestedAt ?? params.now,
          cleanupAfter: existing?.kind === "delete" ? existing.cleanupAfter : params.cleanupAfter,
          historySealedAt: null,
          sealedCursor: null,
          sealedHeadId: null,
          lastError: existing?.kind === "delete" ? existing.lastError : null,
          updatedAt: params.now,
        });
        updatedOrbs.push(updated);
      }
      return {
        conflict: null,
        project: updatedProject,
        orbs: updatedOrbs,
        newlyRequested,
        repaired,
      };
    }).andThen((outcome) =>
      outcome.conflict === "not_found"
        ? errAsync({ type: "project_conflict" as const, reason: "not_found" as const })
        : okAsync({
            project: outcome.project,
            orbs: outcome.orbs,
            newlyRequested: outcome.newlyRequested,
            repaired: outcome.repaired,
          }),
    );
  }

  getProjectDeletionProgress(
    task: SimulationTask,
    projectId: string,
  ): ResultAsync<import("../domain/orb.ts").ProjectDeletionProgress, StoreError | ProjectConflict> {
    return this.access(task, FAILPOINTS.storeRead, "get project deletion progress", () => {
      const project = this.projects.get(projectId);
      if (project === undefined) return { conflict: "not_found" as const };
      if (project.state !== "deleting") return { conflict: "concurrent_change" as const };
      const children = [...this.orbs.values()].filter((orb) => orb.projectId === projectId);
      return {
        conflict: null,
        progress: {
          total: project.deletionInitialOrbCount ?? 0,
          remaining: children.length,
          blocked: children.filter((orb) => this.deletions.get(orb.id)?.lastError !== null).length,
        },
      };
    }).andThen((outcome) =>
      outcome.conflict !== null
        ? errAsync({ type: "project_conflict" as const, reason: outcome.conflict })
        : okAsync(outcome.progress),
    );
  }

  finalizeProjectDeletion(
    task: SimulationTask,
    params: { projectId: string; expectedStateVersion: number },
  ): ResultAsync<void, StoreError | ProjectConflict> {
    return this.access(task, FAILPOINTS.storeWrite, "finalize project deletion", () => {
      const project = this.projects.get(params.projectId);
      if (project === undefined) return { conflict: null };
      if ([...this.orbs.values()].some((orb) => orb.projectId === params.projectId)) {
        return { conflict: "children_remain" as const };
      }
      if (project.state !== "deleting" || project.stateVersion !== params.expectedStateVersion) {
        return { conflict: "concurrent_change" as const };
      }
      this.projects.delete(params.projectId);
      return { conflict: null };
    }).andThen((outcome) =>
      outcome.conflict === null
        ? okAsync(undefined)
        : errAsync({ type: "project_conflict" as const, reason: outcome.conflict }),
    );
  }

  getOrb(task: SimulationTask, orbId: string): ResultAsync<OrbRow | null, StoreError> {
    const scripted = this.scriptedInvariant("getOrb");
    if (scripted !== null) return errAsync(scripted);
    return this.access(task, FAILPOINTS.storeRead, "get orb", () => this.orbs.get(orbId) ?? null);
  }

  getOrbByRuntimeTokenHash(
    task: SimulationTask,
    tokenHash: string,
  ): ResultAsync<OrbRow | null, StoreError> {
    const scripted = this.scriptedInvariant("getOrbByRuntimeTokenHash");
    if (scripted !== null) return errAsync(scripted);
    return this.access(task, FAILPOINTS.storeRead, "get orb by token hash", () => {
      for (const orb of this.orbs.values()) {
        if (orb.runtimeTokenHash === tokenHash) return orb;
      }
      return null;
    });
  }

  listOrbsByProject(task: SimulationTask, projectId: string): ResultAsync<OrbRow[], StoreError> {
    return this.access(task, FAILPOINTS.storeRead, "list orbs by project", () =>
      [...this.orbs.values()].filter((orb) => orb.projectId === projectId),
    );
  }

  listOrbsInStates(
    task: SimulationTask,
    states: readonly OrbState[],
  ): ResultAsync<OrbRow[], StoreError> {
    return this.access(task, FAILPOINTS.storeRead, "list orbs in states", () =>
      [...this.orbs.values()].filter((orb) => states.includes(orb.state)),
    );
  }

  insertOrb(task: SimulationTask, orb: OrbRow): ResultAsync<OrbRow, StoreError | ProjectConflict> {
    return this.access(task, FAILPOINTS.storeWrite, "insert orb", () => {
      const project = this.projects.get(orb.projectId);
      if (project === undefined) return { conflict: "not_found" as const };
      if (project.state !== "active") return { conflict: "deleting" as const };
      this.orbs.set(orb.id, orb);
      return { conflict: null, orb };
    }).andThen((outcome) =>
      outcome.conflict !== null
        ? errAsync({ type: "project_conflict" as const, reason: outcome.conflict })
        : okAsync(outcome.orb),
    );
  }

  setOrbName(
    task: SimulationTask,
    params: { orbId: string; name: string; now: number; onlyIfNull: boolean },
  ): ResultAsync<OrbRow | null, StoreError> {
    return this.access(task, FAILPOINTS.storeWrite, "set orb name", () => {
      const orb = this.orbs.get(params.orbId);
      if (
        orb === undefined ||
        orb.state === "deleting" ||
        orb.state === "archiving" ||
        (params.onlyIfNull && orb.name !== null)
      )
        return null;
      const updated = {
        ...orb,
        name: params.name,
        autoNameLeaseUntil: null,
        autoNameNextAttemptAt: null,
        updatedAt: params.now,
      };
      this.orbs.set(params.orbId, updated);
      return updated;
    });
  }

  claimOrbAutoName(
    task: SimulationTask,
    params: { orbId: string; now: number; leaseUntil: number },
  ): ResultAsync<"claimed" | "already_named" | "in_progress" | "backoff", StoreError> {
    return this.access(task, FAILPOINTS.storeWrite, "claim orb auto name", () => {
      const orb = this.orbs.get(params.orbId);
      if (
        orb === undefined ||
        orb.name !== null ||
        orb.state === "deleting" ||
        orb.state === "archiving" ||
        orb.state === "archived"
      ) {
        return "already_named" as const;
      }
      if (orb.autoNameNextAttemptAt !== null && orb.autoNameNextAttemptAt > params.now)
        return "backoff" as const;
      if (orb.autoNameLeaseUntil !== null && orb.autoNameLeaseUntil > params.now)
        return "in_progress" as const;
      this.orbs.set(params.orbId, {
        ...orb,
        autoNameLeaseUntil: params.leaseUntil,
        autoNameAttempts: orb.autoNameAttempts + 1,
      });
      return "claimed" as const;
    });
  }

  failOrbAutoName(
    task: SimulationTask,
    params: { orbId: string; now: number; nextAttemptAt: number },
  ): ResultAsync<void, StoreError> {
    return this.access(task, FAILPOINTS.storeWrite, "fail orb auto name", () => {
      const orb = this.orbs.get(params.orbId);
      if (
        orb !== undefined &&
        orb.name === null &&
        orb.state !== "deleting" &&
        orb.state !== "archiving" &&
        orb.state !== "archived"
      ) {
        this.orbs.set(params.orbId, {
          ...orb,
          autoNameLeaseUntil: null,
          autoNameNextAttemptAt: params.nextAttemptAt,
          updatedAt: params.now,
        });
      }
    });
  }

  enqueueOrbMessage(
    task: SimulationTask,
    params: {
      orbId: string;
      messageId: string;
      content: OrbMessageRow["content"];
      now: number;
    },
  ): ResultAsync<
    { message: OrbMessageRow; orb: OrbRow; duplicate: boolean },
    StoreError | StateConflict
  > {
    const scripted = this.scriptedInvariant("enqueueOrbMessage");
    if (scripted !== null) return errAsync(scripted);
    return this.access(task, FAILPOINTS.storeWrite, "enqueue orb message", () => {
      const orb = this.orbs.get(params.orbId);
      if (orb === undefined) return { conflict: true as const };
      if (["deleting", "archiving", "archived"].includes(orb.state)) {
        return { conflict: true as const };
      }
      const rows = this.messages.get(params.orbId) ?? [];
      const existing = rows.find((row) => row.messageId === params.messageId);
      if (existing !== undefined) {
        if (!jsonEqual(existing.content, params.content)) return { conflict: true as const };
        return { conflict: false as const, message: existing, orb, duplicate: true };
      }
      // Admission is durable content plus, for an orb that cannot take
      // delivery now, a wake intent — never a lifecycle transition; the
      // reconciler's backstop owns that (docs/lifecycle.md, 2026-08-11).
      const autoStart =
        orb.state === "stopping" || orb.state === "stopped" || orb.state === "failed";
      const message: OrbMessageRow = {
        orbId: params.orbId,
        messageId: params.messageId,
        ordinal: this.nextMessageOrdinal++,
        content: params.content,
        status: "queued",
        delivery: null,
        operationId: null,
        deliveryBatchId: null,
        autoStart,
        wakeStateVersion: autoStart ? orb.stateVersion : null,
        lastError: null,
        createdAt: params.now,
        updatedAt: params.now,
      };
      rows.push(message);
      this.messages.set(params.orbId, rows);
      const updated: OrbRow = {
        ...orb,
        lastBusyAt: Math.max(orb.lastBusyAt ?? 0, params.now),
        updatedAt: params.now,
      };
      this.orbs.set(orb.id, updated);
      return { conflict: false as const, message, orb: updated, duplicate: false };
    }).andThen((outcome) =>
      outcome.conflict
        ? errAsync({ type: "state_conflict" as const })
        : okAsync({ message: outcome.message, orb: outcome.orb, duplicate: outcome.duplicate }),
    );
  }

  listOrbMessages(task: SimulationTask, orbId: string): ResultAsync<OrbMessageRow[], StoreError> {
    return this.access(task, FAILPOINTS.storeRead, "list orb messages", () => [
      ...(this.messages.get(orbId) ?? []),
    ]);
  }

  claimNextOrbMessageBatch(
    task: SimulationTask,
    params: { orbId: string; now: number },
  ): ResultAsync<OrbMessageRow[], StoreError> {
    return this.access(task, FAILPOINTS.storeWrite, "claim orb message batch", () => {
      const rows = this.messages.get(params.orbId) ?? [];
      const outstanding = rows.filter(
        (row) => row.status === "queued" || row.status === "delivering",
      );
      const first = outstanding[0];
      if (first === undefined) return [];
      if (first.deliveryBatchId !== null) {
        return outstanding.filter((row) => row.deliveryBatchId === first.deliveryBatchId);
      }
      const batchId = first.messageId;
      const claimedIds = new Set(
        outstanding.filter((row) => row.status === "queued").map((row) => row.messageId),
      );
      const updated = rows.map((row) =>
        claimedIds.has(row.messageId)
          ? {
              ...row,
              status: "delivering" as const,
              deliveryBatchId: batchId,
              updatedAt: params.now,
            }
          : row,
      );
      this.messages.set(params.orbId, updated);
      return updated.filter((row) => row.deliveryBatchId === batchId);
    });
  }

  noteOrbMessageDelivery(
    task: SimulationTask,
    params: {
      orbId: string;
      messageIds: readonly string[];
      delivery: "turn" | "steer";
      operationId: string;
      now: number;
    },
  ): ResultAsync<void, StoreError> {
    const hold = this.noteDeliveryHold;
    this.noteDeliveryHold = null;
    return this.holdUntil(task, hold, "note orb message delivery hold").andThen(() =>
      this.access(task, FAILPOINTS.storeWrite, "note orb message delivery", () => {
        const rows = this.messages.get(params.orbId) ?? [];
        const messageIds = new Set(params.messageIds);
        for (let index = 0; index < rows.length; index++) {
          const current = rows[index];
          if (
            current !== undefined &&
            messageIds.has(current.messageId) &&
            (current.status === "queued" ||
              current.status === "delivering" ||
              current.status === "delivered")
          ) {
            rows[index] = {
              ...current,
              // Replication may already have committed the inbox record; the
              // note adds its classification without undoing that.
              status: current.status === "delivered" ? "delivered" : "delivering",
              delivery: params.delivery,
              operationId: params.operationId,
              autoStart: false,
              updatedAt: params.now,
            };
          }
        }
      }),
    );
  }

  failOrbMessageBatch(
    task: SimulationTask,
    params: { orbId: string; messageIds: readonly string[]; lastError: string; now: number },
  ): ResultAsync<void, StoreError> {
    return this.access(task, FAILPOINTS.storeWrite, "fail orb message batch", () => {
      const messageIds = new Set(params.messageIds);
      const rows = this.messages.get(params.orbId) ?? [];
      this.messages.set(
        params.orbId,
        rows.map((row) =>
          messageIds.has(row.messageId) && (row.status === "queued" || row.status === "delivering")
            ? {
                ...row,
                status: "failed" as const,
                lastError: params.lastError,
                autoStart: false,
                updatedAt: params.now,
              }
            : row,
        ),
      );
    });
  }

  clearOrbMessageAutoStart(
    task: SimulationTask,
    params: { orbId: string; now: number },
  ): ResultAsync<void, StoreError> {
    return this.access(
      task,
      FAILPOINTS.storeClearMessageAutoStart,
      "clear orb message auto start",
      () => {
        // A scripted blip is a *specific* call failing, which is what scenarios
        // about a stranded wake intent need; the failpoint above is the
        // probabilistic form of the same outage.
        if (this.clearAutoStartFailures > 0) {
          this.clearAutoStartFailures -= 1;
          return { failed: true as const };
        }
        const rows = this.messages.get(params.orbId) ?? [];
        this.messages.set(
          params.orbId,
          rows.map((row) =>
            row.autoStart ? { ...row, autoStart: false, updatedAt: params.now } : row,
          ),
        );
        return { failed: false as const };
      },
    ).andThen((outcome) =>
      outcome.failed
        ? errAsync(unavailable("clear orb message auto start: scripted store failure"))
        : okAsync(undefined),
    );
  }

  casStartOrbForQueuedMessage(
    task: SimulationTask,
    params: { orbId: string; expectedStateVersion: number; now: number },
  ): ResultAsync<OrbRow | null, StoreError | StateConflict> {
    return this.access(task, FAILPOINTS.storeWrite, "start orb for queued message", () => {
      const orb = this.orbs.get(params.orbId);
      if (
        orb === undefined ||
        (orb.state !== "stopped" && orb.state !== "failed") ||
        orb.stateVersion !== params.expectedStateVersion
      ) {
        return { outcome: "conflict" as const };
      }
      // A `stopped` orb wakes for any outstanding intent; a `failed` orb only
      // for an intent admitted against this very failure, and the version bump
      // below retires that privilege (docs/lifecycle.md).
      const wanted = (this.messages.get(params.orbId) ?? []).some(
        (row) =>
          row.autoStart &&
          (row.status === "queued" || row.status === "delivering") &&
          (orb.state === "stopped" || row.wakeStateVersion === orb.stateVersion),
      );
      if (!wanted) return { outcome: "no_intent" as const };
      const updated: OrbRow = {
        ...orb,
        state: "starting",
        stateVersion: orb.stateVersion + 1,
        stateChangedAt: params.now,
        updatedAt: params.now,
        lastError: null,
        stopReason: null,
      };
      this.orbs.set(orb.id, updated);
      return { outcome: "started" as const, orb: updated };
    }).andThen((result) => {
      if (result.outcome === "conflict") {
        return errAsync<OrbRow | null, StateConflict>({ type: "state_conflict" as const });
      }
      return okAsync<OrbRow | null, StateConflict>(
        result.outcome === "started" ? result.orb : null,
      );
    });
  }

  requestOrbArchive(
    task: SimulationTask,
    params: RequestOrbArchiveParams,
  ): ResultAsync<OrbRow, StoreError | StateConflict> {
    return this.access(task, FAILPOINTS.storeWrite, "request orb archive", () => {
      const orb = this.orbs.get(params.orbId);
      if (orb === undefined || orb.stateVersion !== params.expectedStateVersion) {
        return { conflict: true as const, currentState: orb?.state };
      }
      const updated: OrbRow = {
        ...orb,
        state: "archiving",
        stateVersion: orb.stateVersion + 1,
        stateChangedAt: params.now,
        updatedAt: params.now,
        lastError: null,
        stopReason: null,
        autoNameLeaseUntil: null,
        autoNameNextAttemptAt: null,
      };
      this.orbs.set(orb.id, updated);
      this.deletions.set(orb.id, {
        orbId: orb.id,
        hostKind: orb.hostKind,
        kind: "archive",
        requestedAt: params.now,
        cleanupAfter: params.cleanupAfter,
        historySealedAt: null,
        sealedCursor: null,
        sealedHeadId: null,
        lastError: null,
        updatedAt: params.now,
      });
      return { conflict: false as const, row: updated };
    }).andThen((outcome) =>
      outcome.conflict
        ? errAsync<OrbRow, StateConflict>({
            type: "state_conflict",
            ...(outcome.currentState !== undefined ? { currentState: outcome.currentState } : {}),
          })
        : okAsync(outcome.row),
    );
  }

  sealOrbArchive(
    task: SimulationTask,
    params: {
      orbId: string;
      expectedStateVersion: number;
      now: number;
      cursor: string | null;
      headId: string | null;
    },
  ): ResultAsync<void, StoreError | StateConflict> {
    return this.access(task, FAILPOINTS.storeWrite, "seal orb archive", () => {
      const orb = this.orbs.get(params.orbId);
      const intent = this.deletions.get(params.orbId);
      if (
        orb?.state !== "archiving" ||
        orb.stateVersion !== params.expectedStateVersion ||
        intent?.kind !== "archive"
      ) {
        return { conflict: true as const, currentState: orb?.state };
      }
      this.deletions.set(params.orbId, {
        ...intent,
        historySealedAt: params.now,
        sealedCursor: params.cursor,
        sealedHeadId: params.headId,
        lastError: null,
        updatedAt: params.now,
      });
      return { conflict: false as const };
    }).andThen((outcome) =>
      outcome.conflict
        ? errAsync<void, StateConflict>({
            type: "state_conflict",
            ...(outcome.currentState !== undefined ? { currentState: outcome.currentState } : {}),
          })
        : okAsync(undefined),
    );
  }

  finalizeOrbArchive(
    task: SimulationTask,
    params: { orbId: string; expectedStateVersion: number; now: number },
  ): ResultAsync<OrbRow, StoreError | StateConflict> {
    return this.access(task, FAILPOINTS.storeWrite, "finalize orb archive", () => {
      const orb = this.orbs.get(params.orbId);
      const intent = this.deletions.get(params.orbId);
      if (
        orb?.state !== "archiving" ||
        orb.stateVersion !== params.expectedStateVersion ||
        intent?.kind !== "archive" ||
        intent.historySealedAt === null
      ) {
        return { conflict: true as const, currentState: orb?.state };
      }
      const updated: OrbRow = {
        ...orb,
        state: "archived",
        stateVersion: orb.stateVersion + 1,
        stateChangedAt: params.now,
        updatedAt: params.now,
        archivedAt: params.now,
        hostRef: null,
        runtimeTokenHash: null,
        lastBusyAt: null,
        stopReason: null,
        lastError: null,
        autoNameLeaseUntil: null,
        autoNameNextAttemptAt: null,
      };
      this.orbs.set(params.orbId, updated);
      this.deletions.delete(params.orbId);
      return { conflict: false as const, row: updated };
    }).andThen((outcome) =>
      outcome.conflict
        ? errAsync<OrbRow, StateConflict>({
            type: "state_conflict",
            ...(outcome.currentState !== undefined ? { currentState: outcome.currentState } : {}),
          })
        : okAsync(outcome.row),
    );
  }

  requestOrbDeletion(
    task: SimulationTask,
    params: RequestOrbDeletionParams,
  ): ResultAsync<OrbRow, StoreError | StateConflict> {
    return this.access(task, FAILPOINTS.storeWrite, "request orb deletion", () => {
      const orb = this.orbs.get(params.orbId);
      if (orb === undefined || orb.stateVersion !== params.expectedStateVersion) {
        return { conflict: true as const, currentState: orb?.state };
      }
      const updated: OrbRow = {
        ...orb,
        state: "deleting",
        stateVersion: orb.stateVersion + 1,
        stateChangedAt: params.now,
        updatedAt: params.now,
        lastError: null,
        stopReason: null,
      };
      this.orbs.set(orb.id, updated);
      this.deletions.set(orb.id, {
        orbId: orb.id,
        hostKind: orb.hostKind,
        kind: "delete",
        requestedAt: params.now,
        cleanupAfter: params.cleanupAfter,
        historySealedAt: null,
        sealedCursor: null,
        sealedHeadId: null,
        lastError: null,
        updatedAt: params.now,
      });
      return { conflict: false as const, row: updated };
    }).andThen((outcome) =>
      outcome.conflict
        ? errAsync<OrbRow, StateConflict>({
            type: "state_conflict",
            ...(outcome.currentState !== undefined ? { currentState: outcome.currentState } : {}),
          })
        : okAsync(outcome.row),
    );
  }

  getOrbDeletion(
    task: SimulationTask,
    orbId: string,
  ): ResultAsync<OrbDeletionRow | null, StoreError> {
    return this.access(
      task,
      FAILPOINTS.storeRead,
      "get orb deletion",
      () => this.deletions.get(orbId) ?? null,
    );
  }

  recordOrbDeletionError(
    task: SimulationTask,
    params: { orbId: string; message: string | null; now: number },
  ): ResultAsync<void, StoreError> {
    return this.access(task, FAILPOINTS.storeWrite, "record orb deletion error", () => {
      const deletion = this.deletions.get(params.orbId);
      if (deletion !== undefined) {
        this.deletions.set(params.orbId, {
          ...deletion,
          lastError: params.message,
          updatedAt: params.now,
        });
      }
      const orb = this.orbs.get(params.orbId);
      if (orb !== undefined && (orb.state === "deleting" || orb.state === "archiving")) {
        this.orbs.set(params.orbId, {
          ...orb,
          lastError: params.message,
          updatedAt: params.now,
        });
      }
    });
  }

  finalizeOrbDeletion(
    task: SimulationTask,
    params: { orbId: string; expectedStateVersion: number },
  ): ResultAsync<void, StoreError | StateConflict> {
    return this.access(task, FAILPOINTS.storeWrite, "finalize orb deletion", () => {
      const orb = this.orbs.get(params.orbId);
      if (
        orb === undefined ||
        orb.state !== "deleting" ||
        orb.stateVersion !== params.expectedStateVersion ||
        !this.deletions.has(params.orbId)
      ) {
        return { conflict: true as const, currentState: orb?.state };
      }
      this.replicas.delete(params.orbId);
      this.orbs.delete(params.orbId);
      this.deletions.delete(params.orbId);
      return { conflict: false as const };
    }).andThen((outcome) =>
      outcome.conflict
        ? errAsync<void, StateConflict>({
            type: "state_conflict",
            ...(outcome.currentState !== undefined ? { currentState: outcome.currentState } : {}),
          })
        : okAsync(undefined),
    );
  }

  // -- lifecycle CAS --------------------------------------------------------

  failOrbAndRequestComputeDiscard(
    task: SimulationTask,
    params: FailOrbAndRequestComputeDiscardParams,
  ): ResultAsync<OrbRow, StoreError | StateConflict> {
    return this.access(task, FAILPOINTS.storeWrite, "fail orb and request compute discard", () => {
      const orb = this.orbs.get(params.orbId);
      if (orb === undefined || orb.stateVersion !== params.expectedStateVersion) {
        return { conflict: true as const, currentState: orb?.state };
      }
      const updated: OrbRow = {
        ...orb,
        state: "failed",
        stateVersion: orb.stateVersion + 1,
        stateChangedAt: params.now,
        updatedAt: params.now,
        lastError: params.lastError,
        runtimeTokenHash: null,
        hostDiscardThroughIncarnation: orb.hostIncarnation,
        hostDiscardReason: "failed",
        hostDiscardError: null,
        hostDiscardEvidence: params.evidence ?? null,
        hostDiscardRequestedAt: params.now,
      };
      this.orbs.set(orb.id, updated);
      return { conflict: false as const, row: updated };
    }).andThen((outcome) =>
      outcome.conflict
        ? errAsync<OrbRow, StateConflict>({
            type: "state_conflict",
            ...(outcome.currentState !== undefined ? { currentState: outcome.currentState } : {}),
          })
        : okAsync(outcome.row),
    );
  }

  recordHostDiscardStatus(
    task: SimulationTask,
    params: RecordHostDiscardStatusParams,
  ): ResultAsync<void, StoreError> {
    return this.access(task, FAILPOINTS.storeDiscardStatus, "record host discard status", () => {
      const orb = this.orbs.get(params.orbId);
      if (orb === undefined || orb.hostDiscardThroughIncarnation !== params.throughIncarnation) {
        return;
      }
      this.orbs.set(orb.id, {
        ...orb,
        updatedAt: params.now,
        ...(params.evidence !== undefined ? { hostDiscardEvidence: params.evidence } : {}),
        ...(params.error !== undefined ? { hostDiscardError: params.error } : {}),
      });
    });
  }

  finalizeHostDiscard(
    task: SimulationTask,
    params: FinalizeHostDiscardParams,
  ): ResultAsync<OrbRow, StoreError | StateConflict> {
    // The scripted counter runs inside `access`, after its failpoint, so a
    // probability-armed storeDiscardFinalize failpoint is never shadowed.
    return this.access(task, FAILPOINTS.storeDiscardFinalize, "finalize host discard", () => {
      if (this.hostDiscardFinalizeFailures > 0) {
        this.hostDiscardFinalizeFailures -= 1;
        return { scripted: true as const };
      }
      const orb = this.orbs.get(params.orbId);
      if (
        orb === undefined ||
        orb.stateVersion !== params.expectedStateVersion ||
        orb.hostDiscardThroughIncarnation !== params.throughIncarnation ||
        orb.hostIncarnation > params.throughIncarnation
      ) {
        return { conflict: true as const, currentState: orb?.state };
      }
      const updated: OrbRow = {
        ...orb,
        // Same lifecycle episode: preserve a failed wake's version until the
        // failed -> starting transition consumes it.
        updatedAt: params.now,
        hostRef: null,
        runtimeTokenHash: null,
        hostSpecFingerprint:
          orb.hostDiscardReason === "host_spec_changed" ? orb.hostSpecFingerprint : null,
        hostSpecGeneration:
          orb.hostDiscardReason === "host_spec_changed" ? orb.hostSpecGeneration : null,
        hostDiscardThroughIncarnation: null,
        hostDiscardReason: null,
        hostDiscardError: null,
        hostDiscardRequestedAt: null,
        hostIncarnation: params.throughIncarnation + 1,
      };
      this.orbs.set(orb.id, updated);
      return { conflict: false as const, row: updated };
    }).andThen((outcome) => {
      if ("scripted" in outcome) {
        return errAsync<OrbRow, StoreError | StateConflict>(
          unavailable("finalize host discard: scripted store failure"),
        );
      }
      return outcome.conflict
        ? errAsync<OrbRow, StateConflict>({
            type: "state_conflict",
            ...(outcome.currentState !== undefined ? { currentState: outcome.currentState } : {}),
          })
        : okAsync(outcome.row);
    });
  }

  requestHostSpecReplacement(
    task: SimulationTask,
    params: RequestHostSpecReplacementParams,
  ): ResultAsync<
    import("../domain/ports.ts").HostSpecReplacementOutcome,
    StoreError | StateConflict
  > {
    return this.access(task, FAILPOINTS.storeWrite, "request host spec replacement", () => {
      const orb = this.orbs.get(params.orbId);
      if (orb === undefined || orb.stateVersion !== params.expectedStateVersion) {
        return { type: "conflict" as const, currentState: orb?.state };
      }
      if (
        orb.hostRef === null ||
        (params.force !== true && orb.hostSpecFingerprint === params.desiredFingerprint)
      ) {
        return { type: "current" as const, orb };
      }
      const committedGeneration = orb.hostSpecGeneration ?? 0;
      if (params.configuredGeneration < committedGeneration) {
        return { type: "declined" as const, orb, committedGeneration };
      }
      const updated: OrbRow = {
        ...orb,
        runtimeTokenHash: null,
        hostSpecFingerprint: params.desiredFingerprint,
        hostSpecGeneration: params.configuredGeneration,
        hostDiscardThroughIncarnation: orb.hostIncarnation,
        hostDiscardReason: "host_spec_changed",
        hostDiscardError: null,
        // Retained evidence from an earlier failure survives the request: it
        // is cleared only when a replacement commits or a later failure
        // supersedes it (docs/compute-replacement.md).
        hostDiscardRequestedAt: params.now,
        updatedAt: params.now,
      };
      this.orbs.set(orb.id, updated);
      return { type: "requested" as const, orb: updated };
    }).andThen((outcome) =>
      outcome.type === "conflict"
        ? errAsync({
            type: "state_conflict" as const,
            ...(outcome.currentState === undefined ? {} : { currentState: outcome.currentState }),
          })
        : okAsync(outcome),
    );
  }

  casTransition(
    task: SimulationTask,
    params: CasTransitionParams,
  ): ResultAsync<OrbRow, StoreError | StateConflict> {
    return this.access(task, FAILPOINTS.storeWrite, `cas transition to ${params.toState}`, () => {
      const orb = this.orbs.get(params.orbId);
      if (orb === undefined || orb.stateVersion !== params.expectedStateVersion) {
        return { conflict: true as const, currentState: orb?.state };
      }
      const updated: OrbRow = {
        ...orb,
        state: params.toState,
        stateVersion: orb.stateVersion + 1,
        stateChangedAt: params.now,
        updatedAt: params.now,
        ...(params.lastError !== undefined ? { lastError: params.lastError } : {}),
        ...(params.hostRef !== undefined ? { hostRef: params.hostRef } : {}),
        ...(params.checkoutCommit !== undefined ? { checkoutCommit: params.checkoutCommit } : {}),
        ...(params.stopReason !== undefined ? { stopReason: params.stopReason } : {}),
      };
      this.orbs.set(orb.id, updated);
      return { conflict: false as const, row: updated };
    }).andThen((outcome) => {
      if (outcome.conflict) {
        return errAsync<OrbRow, StateConflict>({
          type: "state_conflict",
          ...(outcome.currentState !== undefined ? { currentState: outcome.currentState } : {}),
        });
      }
      return okAsync(outcome.row);
    });
  }

  /**
   * The lifecycle's replacement commit is the only `casUpdateFields` call that
   * installs a host ref and runtime token on a row whose previous ref was
   * cleared by an advanced-incarnation discard finalize. Scripted commit
   * failures (`failNextHostReplacementCommits`) key on exactly that shape; if
   * the commit ever gains an explicit discriminant, replace this predicate.
   */
  private isReplacementCommit(params: CasUpdateFieldsParams): boolean {
    const current = this.orbs.get(params.orbId);
    return (
      current?.hostRef === null &&
      current.hostIncarnation > 0 &&
      params.hostRef != null &&
      params.runtimeTokenHash != null
    );
  }

  casUpdateFields(
    task: SimulationTask,
    params: CasUpdateFieldsParams,
  ): ResultAsync<OrbRow, StoreError | StateConflict> {
    if (this.hostReplacementCommitFailures > 0 && this.isReplacementCommit(params)) {
      this.hostReplacementCommitFailures -= 1;
      return errAsync(unavailable("replacement host commit: scripted store failure"));
    }
    return this.access(task, FAILPOINTS.storeWrite, "cas update fields", () => {
      const orb = this.orbs.get(params.orbId);
      if (orb === undefined || orb.stateVersion !== params.expectedStateVersion) {
        return { conflict: true as const, currentState: orb?.state };
      }
      const updated: OrbRow = {
        ...orb,
        stateVersion: orb.stateVersion + 1,
        updatedAt: params.now,
        ...(params.lastError !== undefined ? { lastError: params.lastError } : {}),
        ...(params.hostRef !== undefined ? { hostRef: params.hostRef } : {}),
        ...(params.checkoutCommit !== undefined ? { checkoutCommit: params.checkoutCommit } : {}),
        ...(params.runtimeTokenHash !== undefined
          ? { runtimeTokenHash: params.runtimeTokenHash }
          : {}),
        ...(params.hostSpecFingerprint !== undefined
          ? { hostSpecFingerprint: params.hostSpecFingerprint }
          : {}),
        ...(params.hostSpecGeneration !== undefined
          ? { hostSpecGeneration: params.hostSpecGeneration }
          : {}),
        ...(params.hostDiscardEvidence !== undefined ? { hostDiscardEvidence: null } : {}),
      };
      this.orbs.set(orb.id, updated);
      return { conflict: false as const, row: updated };
    }).andThen((outcome) => {
      if (outcome.conflict) {
        return errAsync<OrbRow, StateConflict>({
          type: "state_conflict",
          ...(outcome.currentState !== undefined ? { currentState: outcome.currentState } : {}),
        });
      }
      return okAsync(outcome.row);
    });
  }

  touchLastBusy(
    task: SimulationTask,
    params: { orbId: string; now: number },
  ): ResultAsync<void, StoreError> {
    // Same monotone, CAS-free semantics as the pg adapter (docs/lifecycle.md).
    return this.access(task, FAILPOINTS.storeWrite, "touch last busy", () => {
      const orb = this.orbs.get(params.orbId);
      if (orb === undefined) return;
      if (orb.lastBusyAt !== null && orb.lastBusyAt >= params.now) return;
      this.orbs.set(orb.id, {
        ...orb,
        lastBusyAt: params.now,
        updatedAt: Math.max(orb.updatedAt, params.now),
      });
    });
  }

  recordMintFailure(
    task: SimulationTask,
    params: { orbId: string; code: MintFailureCode; at: number },
  ): ResultAsync<void, StoreError> {
    // Same latest-wins, CAS-free semantics as the pg adapter
    // (docs/workload-identity.md).
    return this.access(task, FAILPOINTS.storeWrite, "record mint failure", () => {
      const orb = this.orbs.get(params.orbId);
      if (orb === undefined) return;
      this.orbs.set(orb.id, {
        ...orb,
        mintFailureCode: params.code,
        mintFailureAt: params.at,
        updatedAt: Math.max(orb.updatedAt, params.at),
      });
    });
  }

  claimMintSlot(
    task: SimulationTask,
    params: { orbId: string; at: number; minIntervalMs: number },
  ): ResultAsync<MintSlotClaim, StoreError> {
    // The decision and the write are one indivisible step here, exactly as the
    // pg adapter's conditional UPDATE is (docs/workload-identity.md): every
    // interleaving happens in `access`, never inside this body.
    return this.access(task, FAILPOINTS.storeWrite, "claim mint slot", () => {
      const orb = this.orbs.get(params.orbId);
      if (orb === undefined) return { claimed: false as const, retryAfterMs: params.minIntervalMs };
      const threshold = params.at - params.minIntervalMs;
      if (orb.lastMintAt !== null && orb.lastMintAt > threshold) {
        return {
          claimed: false as const,
          retryAfterMs: Math.max(0, orb.lastMintAt + params.minIntervalMs - params.at),
        };
      }
      this.orbs.set(orb.id, {
        ...orb,
        lastMintAt: params.at,
        updatedAt: Math.max(orb.updatedAt, params.at),
      });
      return { claimed: true as const };
    });
  }

  casReenterState(
    task: SimulationTask,
    params: { orbId: string; expectedStateVersion: number; now: number },
  ): ResultAsync<OrbRow, StoreError | StateConflict> {
    return this.access(task, FAILPOINTS.storeWrite, "cas reenter state", () => {
      const orb = this.orbs.get(params.orbId);
      if (orb === undefined || orb.stateVersion !== params.expectedStateVersion) {
        return { conflict: true as const, currentState: orb?.state };
      }
      const updated: OrbRow = {
        ...orb,
        stateVersion: orb.stateVersion + 1,
        stateChangedAt: params.now,
        updatedAt: params.now,
      };
      this.orbs.set(orb.id, updated);
      return { conflict: false as const, row: updated };
    }).andThen((outcome) =>
      outcome.conflict
        ? errAsync<OrbRow, StateConflict>({
            type: "state_conflict",
            ...(outcome.currentState !== undefined ? { currentState: outcome.currentState } : {}),
          })
        : okAsync(outcome.row),
    );
  }

  // -- replication ----------------------------------------------------------

  private verifySession(
    orb: OrbRow,
    session: HarnessSessionMetadata,
  ): ReplicationIntegrityError | { id: string; header: HarnessSessionMetadata } | null {
    if (orb.harnessSessionId === null) {
      return { id: session.id, header: session };
    }
    if (orb.harnessSessionId !== session.id || !jsonEqual(orb.harnessSessionHeader, session)) {
      if (orb.replicationCursor === null) {
        // An empty replica pins nothing (docs/history-replication.md): with no committed
        // cursor, a changed session identity is legitimate rotation — a
        // runtime that never flushed starts a fresh session on reboot.
        return { id: session.id, header: session };
      }
      return {
        type: "replication_integrity",
        reason: "session_mismatch",
        message: `stored session ${orb.harnessSessionId}, pulled session ${session.id}`,
      };
    }
    return null;
  }

  commitPullBatch(
    task: SimulationTask,
    params: CommitPullBatchParams,
  ): ResultAsync<OrbRow, CommitPullError> {
    type Staged = { kind: "error"; error: CommitPullError } | { kind: "committed"; row: OrbRow };
    const stage = (): Staged => {
      const orb = this.orbs.get(params.orbId);
      if (orb === undefined) {
        return {
          kind: "error",
          error: {
            type: "replication_integrity",
            reason: "mapping_failure",
            message: `orb ${params.orbId} does not exist`,
          },
        };
      }
      // Cursor compare-and-swap: zero rows means another poller won.
      if (orb.replicationCursor !== params.expectedCursor) {
        return { kind: "error", error: { type: "cursor_conflict" } };
      }
      const sessionCheck = this.verifySession(orb, params.session);
      if (sessionCheck !== null && "type" in sessionCheck) {
        return { kind: "error", error: sessionCheck };
      }
      const replica = this.replicaOf(params.orbId);
      const staged: HistoryRecord[] = [];
      const stagedIds = new Set<string>();
      for (const record of params.records) {
        const existing = replica.records.get(record.id);
        if (existing !== undefined) {
          if (!jsonEqual(existing, record)) {
            return {
              kind: "error",
              error: {
                type: "replication_integrity",
                reason: "record_conflict",
                message: `record ${record.id} already exists with different content`,
              },
            };
          }
          continue;
        }
        // Deferred FK: parents must exist by the end of the transaction.
        if (
          record.parentId !== null &&
          !replica.records.has(record.parentId) &&
          !stagedIds.has(record.parentId)
        ) {
          return {
            kind: "error",
            error: {
              type: "replication_integrity",
              reason: "mapping_failure",
              message: `record ${record.id} references unknown parent ${record.parentId}`,
            },
          };
        }
        staged.push(record);
        stagedIds.add(record.id);
      }
      if (
        params.nextHeadId !== null &&
        !replica.records.has(params.nextHeadId) &&
        !stagedIds.has(params.nextHeadId)
      ) {
        return {
          kind: "error",
          error: {
            type: "replication_integrity",
            reason: "mapping_failure",
            message: `replicated head ${params.nextHeadId} not present in replica`,
          },
        };
      }
      if (!replica.records.has(params.nextCursor) && !stagedIds.has(params.nextCursor)) {
        return {
          kind: "error",
          error: {
            type: "replication_integrity",
            reason: "mapping_failure",
            message: `next cursor ${params.nextCursor} not present in replica`,
          },
        };
      }
      // Apply atomically.
      for (const record of staged) {
        replica.records.set(record.id, record);
        replica.order.push(record.id);
      }
      const deliveredIds = new Set(
        staged.flatMap((record) => {
          const native = record.overflow["native"];
          if (typeof native !== "object" || native === null || Array.isArray(native)) return [];
          if (native["type"] !== "custom_message" || native["customType"] !== "pi-orb.user-message")
            return [];
          const details = native["details"];
          if (typeof details !== "object" || details === null || Array.isArray(details)) return [];
          if (Array.isArray(details["messageIds"])) {
            return details["messageIds"].filter((id): id is string => typeof id === "string");
          }
          return typeof details["messageId"] === "string" ? [details["messageId"]] : [];
        }),
      );
      if (deliveredIds.size > 0) {
        const rows = this.messages.get(params.orbId) ?? [];
        this.messages.set(
          params.orbId,
          rows.map((message) =>
            deliveredIds.has(message.messageId)
              ? { ...message, status: "delivered", autoStart: false }
              : message,
          ),
        );
      }
      const updated: OrbRow = {
        ...orb,
        replicationCursor: params.nextCursor,
        replicatedHeadId: params.nextHeadId,
        ...(sessionCheck !== null
          ? { harnessSessionId: sessionCheck.id, harnessSessionHeader: sessionCheck.header }
          : {}),
      };
      this.orbs.set(orb.id, updated);
      return { kind: "committed", row: updated };
    };

    const run = async (): Promise<Staged> => {
      await task.sleep(
        1 + task.random("store latency: commit pull batch") * this.maxLatencyMs,
        "commit pull batch",
      );
      await task.failpoint(FAILPOINTS.storeCommitBefore, params.orbId);
      const outcome = stage();
      if (outcome.kind === "committed") {
        // Crash-equivalent: the transaction landed but the caller sees an error.
        await task.failpoint(FAILPOINTS.storeCommitAfter, params.orbId);
      }
      return outcome;
    };
    return ResultAsync.fromPromise(run(), (error): CommitPullError => {
      if (error instanceof ApplicationFailure) {
        return unavailable(`commit pull batch: ${error.message}`);
      }
      return task.abortSimulation(error);
    }).andThen((outcome) =>
      outcome.kind === "error"
        ? errAsync<OrbRow, CommitPullError>(outcome.error)
        : okAsync(outcome.row),
    );
  }

  initOrVerifySession(
    task: SimulationTask,
    orbId: string,
    session: HarnessSessionMetadata,
  ): ResultAsync<void, StoreError | ReplicationIntegrityError> {
    return this.access(task, FAILPOINTS.storeWrite, "init or verify session", () => {
      const orb = this.orbs.get(orbId);
      if (orb === undefined) return null;
      const sessionCheck = this.verifySession(orb, session);
      if (sessionCheck !== null && "type" in sessionCheck) return sessionCheck;
      if (sessionCheck !== null) {
        this.orbs.set(orbId, {
          ...orb,
          harnessSessionId: sessionCheck.id,
          harnessSessionHeader: sessionCheck.header,
        });
      }
      return null;
    }).andThen((integrity) =>
      integrity === null
        ? okAsync<void, ReplicationIntegrityError>(undefined)
        : errAsync<void, ReplicationIntegrityError>(integrity),
    );
  }

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
  > {
    return this.access(task, FAILPOINTS.storeRead, "read history snapshot", () => {
      const orb = this.orbs.get(orbId);
      if (orb === undefined || orb.state === "deleting") {
        return { session: null, cursor: null, headId: null, records: [] };
      }
      return {
        session: orb.harnessSessionHeader,
        cursor: orb.replicationCursor,
        headId: orb.replicatedHeadId,
        records: this.replicaRecords(orbId),
      };
    });
  }
}

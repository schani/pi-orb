import type { HarnessSessionMetadata, HistoryRecord, OrbState } from "@pi-orb/protocol";
import { ApplicationFailure, type SimulationTask } from "determined";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import type {
  CommitPullError,
  ProjectConflict,
  ReplicationIntegrityError,
  StateConflict,
  StoreError,
} from "../domain/errors.ts";
import { jsonEqual } from "../domain/json-equal.ts";
import type { OrbDeletionRow, OrbRow, ProjectRow } from "../domain/orb.ts";
import type {
  CasTransitionParams,
  CasUpdateFieldsParams,
  CommitPullBatchParams,
  ControlPlaneStore,
  RequestOrbArchiveParams,
  RequestOrbDeletionParams,
} from "../domain/ports.ts";
import { FAILPOINTS } from "./failpoints.ts";

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
 * Deterministic in-memory `ControlPlaneStore` with the same CAS semantics the
 * PostgreSQL adapter must implement. Latency comes from `task.sleep`, failures
 * from named failpoints, so schedules and outages replay exactly.
 */
export class InMemoryControlPlaneStore implements ControlPlaneStore {
  private readonly projects = new Map<string, ProjectRow>();
  private readonly orbs = new Map<string, OrbRow>();
  private readonly replicas = new Map<string, OrbReplica>();
  private readonly deletions = new Map<string, OrbDeletionRow>();

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
    return this.access(task, FAILPOINTS.storeRead, "get orb", () => this.orbs.get(orbId) ?? null);
  }

  getOrbByRuntimeTokenHash(
    task: SimulationTask,
    tokenHash: string,
  ): ResultAsync<OrbRow | null, StoreError> {
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

  casUpdateFields(
    task: SimulationTask,
    params: CasUpdateFieldsParams,
  ): ResultAsync<OrbRow, StoreError | StateConflict> {
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

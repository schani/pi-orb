import { ApplicationFailure, type SimulationTask } from "determined";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import type { HarnessSessionMetadata, HistoryRecord, OrbState } from "@pi-orb/protocol";
import type {
  CommitPullError,
  ReplicationIntegrityError,
  StateConflict,
  StoreError,
} from "../domain/errors.ts";
import type { OrbRow, ProjectRow } from "../domain/orb.ts";
import type {
  CasTransitionParams,
  CasUpdateFieldsParams,
  CommitPullBatchParams,
  ControlPlaneStore,
} from "../domain/ports.ts";
import { FAILPOINTS } from "./failpoints.ts";
import { jsonEqual } from "../domain/json-equal.ts";

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

  orbSnapshot(orbId: string): OrbRow | null {
    return this.orbs.get(orbId) ?? null;
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

  insertProject(task: SimulationTask, project: ProjectRow): ResultAsync<ProjectRow, StoreError> {
    return this.access(task, FAILPOINTS.storeWrite, "insert project", () => {
      this.projects.set(project.id, project);
      return project;
    });
  }

  getOrb(task: SimulationTask, orbId: string): ResultAsync<OrbRow | null, StoreError> {
    return this.access(task, FAILPOINTS.storeRead, "get orb", () => this.orbs.get(orbId) ?? null);
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

  insertOrb(task: SimulationTask, orb: OrbRow): ResultAsync<OrbRow, StoreError> {
    return this.access(task, FAILPOINTS.storeWrite, "insert orb", () => {
      this.orbs.set(orb.id, orb);
      return orb;
    });
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
      return {
        session: orb?.harnessSessionHeader ?? null,
        cursor: orb?.replicationCursor ?? null,
        headId: orb?.replicatedHeadId ?? null,
        records: this.replicaRecords(orbId),
      };
    });
  }
}

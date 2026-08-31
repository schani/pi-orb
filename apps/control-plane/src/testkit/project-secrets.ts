import { ApplicationFailure, type SimulationTask } from "determined";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import type {
  ProjectConflict,
  ProjectSecretPointerConflict,
  StoreError,
} from "../domain/errors.ts";
import type {
  ProjectSecretPointerRow,
  ProjectSecretPointerStore,
  ProjectSecretPointerWrite,
  ProjectSecretsDeps,
  StoredProjectSecretBundle,
} from "../domain/ports.ts";
import { PROJECT_SECRETS_PROVIDER } from "../domain/project-secrets.ts";
import { FakeSecretStore } from "./broker.ts";
import { FAILPOINTS } from "./failpoints.ts";

const unavailable = (message: string): StoreError => ({
  type: "store_error",
  code: "unavailable",
  message,
  retryable: true,
});

function gate<T>(
  task: SimulationTask,
  failpoint: string,
  reason: string,
  f: () => T,
): ResultAsync<T, StoreError> {
  return ResultAsync.fromPromise(
    (async () => {
      await task.sleep(1 + task.random(`${reason} latency`) * 5, reason);
      await task.failpoint(failpoint, reason);
      return f();
    })(),
    (error) =>
      error instanceof ApplicationFailure
        ? unavailable(`${reason}: ${error.message}`)
        : task.abortSimulation(error),
  );
}

export class FakeProjectSecretPointerStore implements ProjectSecretPointerStore {
  private readonly rows = new Map<string, ProjectSecretPointerRow>();
  private readonly states = new Map<string, "active" | "deleting">();
  private readonly writes = new Map<string, ProjectSecretPointerRow[]>();

  constructor(...projectIds: string[]) {
    for (const projectId of projectIds) this.states.set(projectId, "active");
  }

  snapshot(projectId: string): ProjectSecretPointerRow | null {
    return this.rows.get(projectId) ?? null;
  }

  assertMonotonic(projectId: string): void {
    let revision = 0;
    for (const row of this.writes.get(projectId) ?? []) {
      if (row.revision <= revision) throw new Error(`revision regressed at ${row.revision}`);
      revision = row.revision;
    }
  }

  readProjectSecretPointer(
    task: SimulationTask,
    projectId: string,
  ): ResultAsync<ProjectSecretPointerRow | null, StoreError | ProjectConflict> {
    return gate(task, FAILPOINTS.projectSecretPointerRead, "read project secret pointer", () => {
      const state = this.states.get(projectId);
      if (state === undefined) return { kind: "missing" as const };
      if (state === "deleting") return { kind: "deleting" as const };
      return { kind: "value" as const, value: this.rows.get(projectId) ?? null };
    }).andThen((outcome) => {
      if (outcome.kind === "missing") {
        return errAsync({ type: "project_conflict" as const, reason: "not_found" as const });
      }
      if (outcome.kind === "deleting") {
        return errAsync({ type: "project_conflict" as const, reason: "deleting" as const });
      }
      return okAsync(outcome.value);
    });
  }

  casWriteProjectSecretPointer(
    task: SimulationTask,
    projectId: string,
    expectedRowVersion: number | null,
    next: ProjectSecretPointerWrite,
  ): ResultAsync<
    ProjectSecretPointerRow,
    StoreError | ProjectConflict | ProjectSecretPointerConflict
  > {
    return gate(
      task,
      FAILPOINTS.projectSecretPointerWriteBefore,
      "write project secret pointer before",
      () => undefined,
    ).andThen(() => {
      const state = this.states.get(projectId);
      if (state === undefined) {
        return errAsync({ type: "project_conflict" as const, reason: "not_found" as const });
      }
      if (state !== "active") {
        return errAsync({ type: "project_conflict" as const, reason: "deleting" as const });
      }
      const current = this.rows.get(projectId) ?? null;
      if ((current?.rowVersion ?? null) !== expectedRowVersion) {
        return errAsync({ type: "project_secret_pointer_conflict" as const });
      }
      const row: ProjectSecretPointerRow = {
        projectId,
        rowVersion: (current?.rowVersion ?? 0) + 1,
        ...next,
      };
      this.rows.set(projectId, row);
      const writes = this.writes.get(projectId) ?? [];
      writes.push(row);
      this.writes.set(projectId, writes);
      return gate(
        task,
        FAILPOINTS.projectSecretPointerWriteAfter,
        "write project secret pointer after",
        () => row,
      );
    });
  }

  deleteProjectSecretPointer(
    task: SimulationTask,
    projectId: string,
  ): ResultAsync<void, StoreError | ProjectConflict> {
    return gate(
      task,
      FAILPOINTS.projectSecretPointerWriteBefore,
      "delete project secret pointer",
      () => {
        const state = this.states.get(projectId);
        if (state === undefined) return { conflict: "not_found" as const };
        if (state !== "deleting") return { conflict: "concurrent_change" as const };
        this.rows.delete(projectId);
        return { conflict: null };
      },
    ).andThen((outcome) =>
      outcome.conflict === null
        ? okAsync(undefined)
        : errAsync({ type: "project_conflict" as const, reason: outcome.conflict }),
    );
  }

  markProjectDeleting(task: SimulationTask, projectId: string): ResultAsync<void, StoreError> {
    return gate(task, FAILPOINTS.storeWrite, "mark project deleting", () => {
      if (this.states.has(projectId)) this.states.set(projectId, "deleting");
    });
  }
}

export interface ProjectSecretsHarness {
  readonly pointers: FakeProjectSecretPointerStore;
  readonly secrets: FakeSecretStore;
  readonly deps: ProjectSecretsDeps;
  assertPublishedPointersReadable(task: SimulationTask): Promise<void>;
}

export function makeProjectSecretsHarness(...projectIds: string[]): ProjectSecretsHarness {
  const pointers = new FakeProjectSecretPointerStore(...projectIds);
  const secrets = new FakeSecretStore({
    read: FAILPOINTS.projectSecretRead,
    write: FAILPOINTS.projectSecretWrite,
    destroy: FAILPOINTS.projectSecretDestroy,
    list: FAILPOINTS.projectSecretList,
  });
  const deps = { pointers, secrets };
  return {
    pointers,
    secrets,
    deps,
    async assertPublishedPointersReadable(task) {
      for (const projectId of projectIds) {
        const pointer = pointers.snapshot(projectId);
        if (pointer === null) continue;
        const bundle = await secrets.readSecret<StoredProjectSecretBundle>(
          task,
          PROJECT_SECRETS_PROVIDER,
          pointer.secretVersion,
        );
        if (bundle.isErr()) continue;
        if (
          bundle.value === null ||
          bundle.value.projectId !== projectId ||
          bundle.value.revision !== pointer.revision
        ) {
          throw new Error(`unreadable published pointer for ${projectId}`);
        }
      }
    },
  };
}

import { randomUUID } from "node:crypto";
import type { SimulationTask } from "determined";
import { err, errAsync, okAsync, ResultAsync } from "neverthrow";
import type { RuntimeClientError } from "../../domain/errors.ts";
import { logOrbEvent } from "../../domain/log.ts";
import type { OrbRow } from "../../domain/orb.ts";
import type { ControlPlaneStore, OperationContext } from "../../domain/ports.ts";
import { type AuthorityError, PgDurableAuthority } from "../durable-pg/index.ts";
import type { PostgreSQLClient } from "../pg/client.ts";
import { projectNativeCommit } from "./atomic-history.ts";
import { checkNativeInputAdmission } from "./inbox-admission.ts";
import type {
  AgentLeaseError,
  AgentPersistence,
  AgentStorageLease,
  InputAdmissionError,
} from "./persistence.ts";
import { PgAgentArtifacts } from "./pg-artifacts.ts";
import { checkNativeStartup, startupRuntimeError } from "./startup.ts";

const leaseMs = 60_000;
const renewalMs = 20_000;
const failure = (message: string): RuntimeClientError => ({
  type: "runtime_client_error",
  code: "history_unavailable",
  answered: true,
  retryable: true,
  message,
});

/** Per-orb database leases; no filesystem authority or global owner lock. */
export class PgAgentPersistence implements AgentPersistence {
  private readonly ownerId = randomUUID();
  private readonly releases = new Set<() => ResultAsync<void, RuntimeClientError>>();
  private closed = false;
  private readonly db: PostgreSQLClient;
  private readonly store: Pick<ControlPlaneStore, "readHistorySnapshot">;
  private readonly authorityNow: (() => number) | undefined;
  constructor(
    db: PostgreSQLClient,
    store: Pick<ControlPlaneStore, "readHistorySnapshot">,
    authorityNow?: () => number,
  ) {
    this.db = db;
    this.store = store;
    this.authorityNow = authorityNow;
  }

  recoveryDemand(_task: SimulationTask, orb: OrbRow, context: OperationContext) {
    if (context.signal.aborted) return errAsync(failure("Agent recovery demand check cancelled"));
    return this.db
      .query(
        `SELECT EXISTS (
        SELECT 1 FROM durable_pg_tasks WHERE orb_id=$1
          AND status IN ('pending','running','sleeping','waiting','completing')
      ) OR EXISTS (
        SELECT 1 FROM durable_pg_submissions WHERE orb_id=$1 AND status IN ('queued','placed')
      ) AS demand`,
        [orb.id],
      )
      .mapErr(() => failure("Persisted agent demand unavailable"))
      .map((result) => result.rows[0]?.demand === true);
  }

  checkStartup(_task: SimulationTask, orb: OrbRow, context: OperationContext) {
    if (context.signal.aborted) return errAsync(failure("Agent startup check cancelled"));
    return this.db
      .transaction<void, AuthorityError | import("../../domain/errors.ts").StoreError>(
        async (query) => {
          const current = await query(
            "SELECT state,agent_admission_version FROM orbs WHERE id=$1 FOR UPDATE",
            [orb.id],
          );
          if (current.isErr()) return err(current.error);
          const row = current.value.rows[0];
          if (!row || Number(row.agent_admission_version) !== orb.agentAdmissionVersion)
            return err<never, AuthorityError>({
              type: "authority_error",
              code: "stale_owner",
              message: "Agent admission changed",
            });
          const sealed = await query(
            "SELECT archived FROM durable_pg_owners WHERE orb_id=$1 FOR UPDATE",
            [orb.id],
          );
          if (sealed.isErr()) return err(sealed.error);
          if (
            row.state === "archived" ||
            row.state === "archiving" ||
            row.state === "deleting" ||
            sealed.value.rows[0]?.archived
          )
            return err<never, AuthorityError>({
              type: "authority_error",
              code: "closed",
              message: "Agent authority is closed",
            });
          return checkNativeStartup(query, orb.id, true);
        },
      )
      .mapErr((error) =>
        error.type === "authority_error"
          ? startupRuntimeError(error)
          : failure("Agent startup check unavailable"),
      );
  }

  open(
    task: SimulationTask,
    orb: OrbRow,
    context: OperationContext,
  ): ResultAsync<AgentStorageLease, RuntimeClientError> {
    if (this.closed || context.signal.aborted) return errAsync(failure("Agent persistence closed"));
    const authority = new PgDurableAuthority(this.db, this.authorityNow);
    const now = task.wallNow();
    return authority
      .acquire(orb.id, this.ownerId, orb.agentAdmissionVersion, now, now + leaseMs, (query) =>
        checkNativeStartup(query, orb.id, true),
      )
      .mapErr(startupRuntimeError)
      .andThen((owner) =>
        authority
          .open(owner, {
            admit: (query) => checkNativeStartup(query, orb.id),
            project: (query, writes, _seq, admittedSubmissions) =>
              projectNativeCommit(query, orb.id, writes, admittedSubmissions),
          })
          .mapErr(startupRuntimeError)
          .map((storage) => {
            logOrbEvent(task, orb.id, "agent.owner_acquired", {
              fence: owner.fence,
              admission_version: owner.admissionVersion,
            });
            const abort = new AbortController();
            let released = false;
            const check = (): ResultAsync<void, AgentLeaseError> => {
              if (released || abort.signal.aborted)
                return errAsync(failure("Agent ownership revoked"));
              const at = task.wallNow();
              return authority.renew(owner, at, at + leaseMs).mapErr((cause) => {
                if (!abort.signal.aborted)
                  logOrbEvent(task, orb.id, "agent.owner_lost", {
                    fence: owner.fence,
                    admission_version: owner.admissionVersion,
                    cause_code: cause.code,
                  });
                abort.abort();
                return { ...failure("Agent ownership revoked"), cause };
              });
            };
            const heartbeat = (async () => {
              while (!abort.signal.aborted) {
                const waited = await ResultAsync.fromPromise(
                  task.sleep(renewalMs, "renew agent owner", { signal: abort.signal }),
                  () => failure("Owner renewal cancelled"),
                );
                if (waited.isErr() || abort.signal.aborted) break;
                await task.checkpoint("agent owner renewal", orb.id, owner.fence);
                if ((await check()).isErr()) break;
              }
            })();
            let releaseResult: ResultAsync<void, RuntimeClientError> | undefined;
            const release = () =>
              (releaseResult ??= ResultAsync.fromPromise(
                (async () => {
                  released = true;
                  abort.abort();
                  await heartbeat;
                  const result = await authority.release(owner);
                  if (result.isOk())
                    logOrbEvent(task, orb.id, "agent.owner_released", {
                      fence: owner.fence,
                      admission_version: owner.admissionVersion,
                    });
                  return result;
                })(),
                () => failure("Agent ownership release failed"),
              )
                .andThen((result) => {
                  if (result.isOk() || result.error.code === "stale_owner") {
                    this.releases.delete(release);
                    return okAsync(undefined);
                  }
                  logOrbEvent(task, orb.id, "agent.owner_release_failed", {
                    fence: owner.fence,
                    admission_version: owner.admissionVersion,
                    cause_code: result.error.code,
                  });
                  return errAsync({
                    ...failure("Agent ownership release failed"),
                    cause: result.error,
                  });
                })
                .orTee(() => {
                  releaseResult = undefined;
                }));
            this.releases.add(release);
            return {
              storage,
              artifacts: new PgAgentArtifacts(authority, owner),
              check,
              checkInputAdmission: (browser: boolean) =>
                checkNativeInputAdmission(this.db.query.bind(this.db), orb.id, browser).mapErr(
                  (error): InputAdmissionError =>
                    error.type === "authority_error" && error.code === "busy"
                      ? { type: "input_admission_refused", error: startupRuntimeError(error) }
                      : {
                          type: "input_admission_failed",
                          cause:
                            error.type === "authority_error"
                              ? error
                              : {
                                  type: "authority_error",
                                  code:
                                    error.code === "unavailable"
                                      ? "unavailable"
                                      : "history_integrity",
                                  message:
                                    error.code === "unavailable"
                                      ? "Durable authority database unavailable"
                                      : "Durable storage integrity failure",
                                },
                        },
                ),
              beginDrain: () =>
                authority
                  .beginDrain(owner, storage)
                  .andTee((outcome) => {
                    logOrbEvent(task, orb.id, "agent.owner_drain", {
                      fence: owner.fence,
                      admission_version: owner.admissionVersion,
                      outcome: outcome?.type ?? "draining",
                      cause_code: outcome?.cause.code,
                    });
                  })
                  .mapErr((cause) => {
                    logOrbEvent(task, orb.id, "agent.owner_drain", {
                      fence: owner.fence,
                      admission_version: owner.admissionVersion,
                      outcome: "failed",
                      cause_code: cause.code,
                    });
                    return { ...failure("Agent drain ownership unavailable"), cause };
                  }),
              signal: abort.signal,
              release,
            };
          }),
      );
  }

  snapshot(task: SimulationTask, orb: OrbRow) {
    return this.store
      .readHistorySnapshot(task, orb.id)
      .mapErr(() => failure("Conversation history unavailable"))
      .map((snapshot) => ({
        orbId: orb.id,
        runtimeInstanceId: `conversation:${orb.id}`,
        activity: "idle" as const,
        session: snapshot.session ?? {
          id: `conversation:${orb.id}`,
          overflow: { harness: "pi-durable" },
        },
        records: snapshot.records,
        headId: snapshot.headId,
      }));
  }

  dispose(_task: SimulationTask, _orbId: string, _deleteAuthority: boolean) {
    // Sealing and private cleanup are one store transaction; deletion cascades with the orb row.
    return okAsync<void, RuntimeClientError>(undefined);
  }

  close() {
    this.closed = true;
    return ResultAsync.combine([...this.releases].map((release) => release())).map(() => undefined);
  }
}

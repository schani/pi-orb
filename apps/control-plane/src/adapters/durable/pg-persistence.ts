import { randomUUID } from "node:crypto";
import type { SimulationTask } from "determined";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import type { RuntimeClientError } from "../../domain/errors.ts";
import { logOrbEvent } from "../../domain/log.ts";
import type { OrbRow } from "../../domain/orb.ts";
import type { ControlPlaneStore, OperationContext } from "../../domain/ports.ts";
import { PgDurableAuthority } from "../durable-pg/index.ts";
import type { PostgreSQLClient } from "../pg/client.ts";
import { projectNativeCommit } from "./atomic-history.ts";
import type { AgentPersistence, AgentStorageLease } from "./persistence.ts";
import { PgAgentArtifacts } from "./pg-artifacts.ts";

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
  constructor(db: PostgreSQLClient, store: Pick<ControlPlaneStore, "readHistorySnapshot">) {
    this.db = db;
    this.store = store;
  }

  open(
    task: SimulationTask,
    orb: OrbRow,
    context: OperationContext,
  ): ResultAsync<AgentStorageLease, RuntimeClientError> {
    if (this.closed || context.signal.aborted) return errAsync(failure("Agent persistence closed"));
    const authority = new PgDurableAuthority(this.db);
    const now = task.wallNow();
    return authority
      .acquire(orb.id, this.ownerId, orb.agentAdmissionVersion, now, now + leaseMs)
      .mapErr(() => failure("Agent ownership unavailable"))
      .andThen((owner) =>
        authority
          .open(owner, { project: (query, writes) => projectNativeCommit(query, orb.id, writes) })
          .mapErr(() => failure("Agent authority unavailable"))
          .map((storage) => {
            logOrbEvent(task, orb.id, "agent.owner_acquired", {
              fence: owner.fence,
              admission_version: owner.admissionVersion,
            });
            const abort = new AbortController();
            let released = false;
            const check = (): ResultAsync<void, RuntimeClientError> => {
              if (released || abort.signal.aborted)
                return errAsync(failure("Agent ownership revoked"));
              const at = task.wallNow();
              return authority.renew(owner, at, at + leaseMs).mapErr(() => {
                if (!abort.signal.aborted)
                  logOrbEvent(task, orb.id, "agent.owner_lost", {
                    fence: owner.fence,
                    admission_version: owner.admissionVersion,
                  });
                abort.abort();
                return failure("Agent ownership revoked");
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
                  this.releases.delete(release);
                  if (result.isOk())
                    logOrbEvent(task, orb.id, "agent.owner_released", {
                      fence: owner.fence,
                      admission_version: owner.admissionVersion,
                    });
                  return result;
                })(),
                () => failure("Agent ownership release failed"),
              ).andThen((result) =>
                result.isOk() || result.error.code === "stale_owner"
                  ? okAsync(undefined)
                  : errAsync(failure("Agent ownership release failed")),
              ));
            this.releases.add(release);
            return {
              storage,
              artifacts: new PgAgentArtifacts(authority, owner),
              check,
              beginDrain: () =>
                authority
                  .beginDrain(owner, storage)
                  .mapErr(() => failure("Agent drain ownership unavailable")),
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

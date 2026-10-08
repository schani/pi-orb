import type { Seq, Storage, StorageWrite } from "@earendil-works/pi-durable";
import { StorageRejected } from "@earendil-works/pi-durable";
import { err, ok, Result, ResultAsync } from "neverthrow";
import type { StoreError } from "../../domain/errors.ts";
import type { PostgreSQLClient } from "../pg/client.ts";
import { executor, type Query, type SqlDatabase, type SqlExecutor } from "./executor.ts";
import { PgStorage } from "./storage.ts";
import { rejectStorage, storageAuthorityError } from "./storage-boundary.ts";

export type AuthorityError = {
  type: "authority_error";
  code:
    | "unavailable"
    | "stale_owner"
    | "busy"
    | "missing"
    | "projection"
    | "closed"
    | "legacy_backend"
    | "history_integrity";
  message: string;
};
export type Ownership = { orbId: string; ownerId: string; fence: number; admissionVersion: number };
export type CommitOptions = {
  admit?(query: Query): Promise<Result<void, AuthorityError | StoreError>>;
  project(
    query: Query,
    writes: readonly StorageWrite[],
    seq: Seq,
  ): Promise<Result<void, AuthorityError | StoreError>>;
  afterCommit?(seq: Seq): void;
  checkpoint?(
    phase: "before_native" | "after_native" | "after_projection" | "after_commit",
  ): Promise<void>;
};
const failure = (code: AuthorityError["code"], message: string): AuthorityError => ({
  type: "authority_error",
  code,
  message,
});
const unavailable = () => failure("unavailable", "Durable authority database unavailable");

/** Production ownership deadlines use database time after locking. */
export class PgDurableAuthority {
  private readonly db: PostgreSQLClient;
  private readonly drains = new WeakMap<
    Storage,
    { ownership: Ownership; isClosed(): boolean; activate(): boolean }
  >();
  private readonly now: (() => number) | undefined;
  constructor(db: PostgreSQLClient, now?: () => number) {
    this.db = db;
    this.now = now;
  }

  private async time(query: Query): Promise<Result<number, AuthorityError>> {
    if (this.now) return ok(this.now());
    return (
      await query("SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now")
    )
      .map((result) => Number(result.rows[0]?.now))
      .mapErr(unavailable);
  }

  acquire(
    orbId: string,
    ownerId: string,
    admissionVersion: number,
    now: number,
    leaseUntil: number,
    admit?: (query: Query) => Promise<Result<void, AuthorityError | StoreError>>,
  ): ResultAsync<Ownership, AuthorityError> {
    return this.db
      .transaction<Ownership, AuthorityError>(async (query) => {
        if (leaseUntil <= now) return err(failure("stale_owner", "Invalid ownership deadline"));
        const orb = await query("SELECT agent_admission_version FROM orbs WHERE id=$1 FOR UPDATE", [
          orbId,
        ]);
        if (orb.isErr()) return err(unavailable());
        if (!orb.value.rows[0]) return err(failure("missing", "Orb does not exist"));
        if (Number(orb.value.rows[0].agent_admission_version) !== admissionVersion)
          return err(failure("stale_owner", "Agent admission changed"));
        const previous = await query("SELECT * FROM durable_pg_owners WHERE orb_id=$1 FOR UPDATE", [
          orbId,
        ]);
        if (previous.isErr()) return err(unavailable());
        const clock = await this.time(query);
        if (clock.isErr()) return err(clock.error);
        const deadline = clock.value + (leaseUntil - now);
        const row = previous.value.rows[0];
        if (row?.archived) return err(failure("closed", "Private authority is archived"));
        if (row && Number(row.lease_until) > clock.value && row.owner_id !== ownerId)
          return err(failure("busy", "Orb agent already owned"));
        const admitted = await admit?.(query);
        if (admitted?.isErr())
          return err(admitted.error.type === "authority_error" ? admitted.error : unavailable());
        const fence = row ? Number(row.fence) + 1 : 1;
        const write = await query(
          `INSERT INTO durable_pg_owners(orb_id,owner_id,fence,admission_version,lease_until)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(orb_id) DO UPDATE SET owner_id=excluded.owner_id,fence=excluded.fence,admission_version=excluded.admission_version,lease_until=excluded.lease_until`,
          [orbId, ownerId, fence, admissionVersion, deadline],
        );
        if (write.isErr()) return err(unavailable());
        const metadata = await query(
          "INSERT INTO durable_pg_durable_metadata(orb_id,singleton,next_id,next_seq) VALUES($1,1,'2',1) ON CONFLICT DO NOTHING",
          [orbId],
        );
        if (metadata.isErr()) return err(unavailable());
        const event = await query(
          "INSERT INTO durable_pg_owner_events(orb_id,fence,outcome,recorded_at) VALUES($1,$2,'acquired',$3)",
          [orbId, fence, clock.value],
        );
        if (event.isErr()) return err(unavailable());
        return ok({ orbId, ownerId, fence, admissionVersion });
      })
      .mapErr((error) => (error.type === "authority_error" ? error : unavailable()));
  }

  private async guard(
    query: Query,
    ownership: Ownership,
    drain = false,
  ): Promise<Result<void, AuthorityError>> {
    const orb = await query("SELECT agent_admission_version FROM orbs WHERE id=$1 FOR UPDATE", [
      ownership.orbId,
    ]);
    if (orb.isErr()) return err(unavailable());
    if (!orb.value.rows[0]) return err(failure("missing", "Orb does not exist"));
    if (!drain && Number(orb.value.rows[0].agent_admission_version) !== ownership.admissionVersion)
      return err(failure("stale_owner", "Agent admission changed"));
    const owner = await query("SELECT * FROM durable_pg_owners WHERE orb_id=$1 FOR UPDATE", [
      ownership.orbId,
    ]);
    if (owner.isErr()) return err(unavailable());
    const clock = await this.time(query);
    if (clock.isErr()) return err(clock.error);
    const row = owner.value.rows[0];
    return row &&
      !row.archived &&
      row.owner_id === ownership.ownerId &&
      Number(row.fence) === ownership.fence &&
      Number(row.admission_version) === ownership.admissionVersion &&
      Number(row.lease_until) > clock.value
      ? ok(undefined)
      : err(failure("stale_owner", "Agent ownership revoked"));
  }

  renew(ownership: Ownership, now: number, leaseUntil: number): ResultAsync<void, AuthorityError> {
    return this.db
      .transaction<void, AuthorityError>(async (query) => {
        const guarded = await this.guard(query, ownership);
        if (guarded.isErr()) return err(guarded.error);
        if (leaseUntil <= now) return err(failure("stale_owner", "Invalid ownership deadline"));
        const clock = await this.time(query);
        if (clock.isErr()) return err(clock.error);
        return (
          await query("UPDATE durable_pg_owners SET lease_until=$2 WHERE orb_id=$1", [
            ownership.orbId,
            clock.value + (leaseUntil - now),
          ])
        )
          .map(() => undefined)
          .mapErr(unavailable);
      })
      .mapErr((error) => (error.type === "authority_error" ? error : unavailable()));
  }

  beginDrain(ownership: Ownership, storage: Storage): ResultAsync<void, AuthorityError> {
    const capability = this.drains.get(storage);
    if (capability?.isClosed())
      return new ResultAsync(Promise.resolve(err(failure("closed", "Storage is closed"))));
    if (
      !capability ||
      capability.ownership.orbId !== ownership.orbId ||
      capability.ownership.ownerId !== ownership.ownerId ||
      capability.ownership.fence !== ownership.fence ||
      capability.ownership.admissionVersion !== ownership.admissionVersion
    )
      return new ResultAsync(
        Promise.resolve(err(failure("stale_owner", "Storage ownership mismatch"))),
      );
    return this.db
      .transaction<void, AuthorityError>(async (query) => {
        const guarded = await this.guard(query, ownership, true);
        if (guarded.isErr()) return guarded;
        const clock = await this.time(query);
        if (clock.isErr()) return err(clock.error);
        return (
          await query(
            "INSERT INTO durable_pg_owner_events(orb_id,fence,outcome,recorded_at) VALUES($1,$2,'draining',$3) ON CONFLICT DO NOTHING",
            [ownership.orbId, ownership.fence, clock.value],
          )
        )
          .map(() => undefined)
          .mapErr(unavailable);
      })
      .mapErr((error) => (error.type === "authority_error" ? error : unavailable()))
      .andThen(() =>
        capability.activate() ? ok(undefined) : err(failure("closed", "Storage is closed")),
      );
  }

  release(ownership: Ownership): ResultAsync<void, AuthorityError> {
    return this.db
      .transaction<void, AuthorityError>(async (query) => {
        const orb = await query("SELECT id FROM orbs WHERE id=$1 FOR UPDATE", [ownership.orbId]);
        if (orb.isErr()) return err(unavailable());
        const previous = await query("SELECT * FROM durable_pg_owners WHERE orb_id=$1 FOR UPDATE", [
          ownership.orbId,
        ]);
        if (previous.isErr()) return err(unavailable());
        const row = previous.value.rows[0];
        if (
          !row ||
          row.owner_id !== ownership.ownerId ||
          Number(row.admission_version) !== ownership.admissionVersion
        )
          return err(failure("stale_owner", "Agent ownership revoked"));
        if (Number(row.fence) === ownership.fence + 1 && Number(row.lease_until) === 0)
          return ok(undefined);
        if (Number(row.fence) !== ownership.fence || row.archived)
          return err(failure("stale_owner", "Agent ownership revoked"));
        const clock = await this.time(query);
        if (clock.isErr()) return err(clock.error);
        const released = await query(
          "UPDATE durable_pg_owners SET fence=fence+1, lease_until=0 WHERE orb_id=$1",
          [ownership.orbId],
        );
        if (released.isErr()) return err(unavailable());
        return (
          await query(
            "INSERT INTO durable_pg_owner_events(orb_id,fence,outcome,recorded_at) VALUES($1,$2,'released',$3)",
            [ownership.orbId, ownership.fence, clock.value],
          )
        )
          .map(() => undefined)
          .mapErr(unavailable);
      })
      .mapErr((error) => (error.type === "authority_error" ? error : unavailable()));
  }

  validate(ownership: Ownership): ResultAsync<void, AuthorityError> {
    return this.ownedTransaction(ownership, async () => ok(undefined));
  }

  ownedTransaction<T>(
    ownership: Ownership,
    callback: (query: Query) => Promise<Result<T, AuthorityError | StoreError>>,
  ): ResultAsync<T, AuthorityError> {
    return this.db
      .transaction<T, AuthorityError | StoreError>(async (query) => {
        const guarded = await this.guard(query, ownership);
        return guarded.isErr() ? err(guarded.error) : callback(query);
      })
      .mapErr((error) => (error.type === "authority_error" ? error : unavailable()));
  }

  open(ownership: Ownership, options: CommitOptions): ResultAsync<Storage, AuthorityError> {
    return this.openStorage(ownership.orbId, { ...ownership }, options);
  }
  read(orbId: string): ResultAsync<Storage, AuthorityError> {
    return this.openStorage(orbId);
  }

  private openStorage(
    orbId: string,
    ownership?: Ownership,
    options?: CommitOptions,
  ): ResultAsync<Storage, AuthorityError> {
    let closed = false;
    let draining = false;
    const readQuery: Query = (sql, values) => this.db.query(sql, values);
    const sql = executor(readQuery, orbId);
    const database: SqlDatabase = {
      ...sql,
      close: async () => {
        closed = true;
      },
      mintId: async () => {
        if (closed || !ownership) rejectStorage("Read-only or closed authority");
        const result = await this.db.transaction<number, AuthorityError>(async (query) => {
          const guarded = await this.guard(query, ownership, draining);
          if (guarded.isErr()) return err(guarded.error);
          const admitted = await options?.admit?.(query);
          if (admitted?.isErr())
            return err(admitted.error.type === "authority_error" ? admitted.error : unavailable());
          const id = await query(
            "UPDATE durable_pg_durable_metadata SET next_id=(next_id::bigint+1)::text WHERE orb_id=$1 RETURNING (next_id::bigint-1)::text AS id",
            [orbId],
          );
          return id.isErr() ? err(unavailable()) : ok(Number(id.value.rows[0]?.id));
        });
        if (result.isErr())
          rejectStorage("Durable ID allocation rejected", { cause: result.error });
        return result.value;
      },
      transaction: async <T>(callback: (executor: SqlExecutor) => Promise<T>): Promise<T> => {
        if (closed || !ownership || !options) rejectStorage("Read-only or closed authority");
        const result = await this.db.transaction<T, AuthorityError>(async (query) => {
          const guarded = await this.guard(query, ownership, draining);
          if (guarded.isErr()) return err(guarded.error);
          const admitted = await options.admit?.(query);
          if (admitted?.isErr())
            return err(admitted.error.type === "authority_error" ? admitted.error : unavailable());
          const run = await ResultAsync.fromPromise(
            (async () => {
              await options.checkpoint?.("before_native");
              return callback(executor(query, orbId));
            })(),
            (error) =>
              storageAuthorityError(error) ??
              failure(
                "projection",
                error instanceof StorageRejected ? error.message : "Durable transaction rejected",
              ),
          );
          return run as Result<T, AuthorityError>;
        });
        if (result.isErr())
          rejectStorage(
            result.error.type === "authority_error"
              ? result.error.message
              : "Durable commit rejected",
            { cause: result.error },
          );
        if (typeof result.value === "number") {
          // Notification failure cannot turn an acknowledged database commit into a rollback.
          Result.fromThrowable(
            () => options.afterCommit?.(result.value as unknown as Seq),
            unavailable,
          )();
          if (options.checkpoint)
            await ResultAsync.fromPromise(options.checkpoint("after_commit"), unavailable);
        }
        return result.value;
      },
      project: async (transaction, writes, seq) => {
        if (!options) rejectStorage("Read-only authority");
        await options.checkpoint?.("after_native");
        const result = await options.project(transaction.query, writes, seq);
        if (result.isErr())
          rejectStorage("Public history projection rejected", { cause: result.error });
        await options.checkpoint?.("after_projection");
      },
    };
    return ResultAsync.fromPromise(
      PgStorage.open(database),
      (error) => storageAuthorityError(error) ?? failure("missing", "Private authority is missing"),
    ).map((storage) => {
      if (ownership)
        this.drains.set(storage, {
          ownership: { ...ownership },
          isClosed: () => closed,
          activate: () => {
            if (closed) return false;
            draining = true;
            return true;
          },
        });
      return storage;
    });
  }

  archive(
    ownership: Ownership,
    sealAndCleanup: (query: Query) => Promise<Result<void, AuthorityError | StoreError>>,
  ): ResultAsync<void, AuthorityError> {
    return this.db
      .transaction<void, AuthorityError | StoreError>(async (query) => {
        const orb = await query("SELECT agent_admission_version FROM orbs WHERE id=$1 FOR UPDATE", [
          ownership.orbId,
        ]);
        if (orb.isErr()) return err(unavailable());
        const previous = await query("SELECT * FROM durable_pg_owners WHERE orb_id=$1 FOR UPDATE", [
          ownership.orbId,
        ]);
        if (previous.isErr()) return err(unavailable());
        const row = previous.value.rows[0];
        if (
          row?.archived &&
          row.owner_id === ownership.ownerId &&
          Number(row.fence) === ownership.fence + 1
        )
          return ok(undefined);
        const guarded = await this.guard(query, ownership, true);
        if (guarded.isErr()) return err(guarded.error);
        const clock = await this.time(query);
        if (clock.isErr()) return err(clock.error);
        const sealed = await sealAndCleanup(query);
        if (sealed.isErr()) return sealed;
        for (const table of [
          "document_revisions",
          "documents",
          "submissions",
          "tasks",
          "entries",
          "conversations",
          "record_ids",
          "durable_metadata",
        ]) {
          const removed = await query(`DELETE FROM durable_pg_${table} WHERE orb_id=$1`, [
            ownership.orbId,
          ]);
          if (removed.isErr()) return err(unavailable());
        }
        const archived = await query(
          "UPDATE durable_pg_owners SET archived=true, fence=fence+1, lease_until=0 WHERE orb_id=$1",
          [ownership.orbId],
        );
        if (archived.isErr()) return err(unavailable());
        return (
          await query(
            "INSERT INTO durable_pg_owner_events(orb_id,fence,outcome,recorded_at) VALUES($1,$2,'archived',$3)",
            [ownership.orbId, ownership.fence, clock.value],
          )
        )
          .map(() => undefined)
          .mapErr(unavailable);
      })
      .mapErr((error) => (error.type === "authority_error" ? error : unavailable()));
  }
}

export type { Query } from "./executor.ts";
export { readTransactionStorage } from "./transaction-reader.ts";

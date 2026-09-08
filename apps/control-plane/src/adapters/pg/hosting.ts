import type { SimulationTask } from "determined";
import { err, ok, type Result, type ResultAsync } from "neverthrow";
import type { StoreError } from "../../domain/errors.ts";
import type { HostingStore } from "../../domain/hosting-ports.ts";
import type {
  HostedFile,
  HostedFileInventory,
  HostedObjectRef,
  HostingAttempt,
  HostingCleanupClaim,
  HostingCleanupItem,
  HostingError,
  HostingOperation,
  HostingUploadRequest,
  StoredHostedObject,
} from "../../domain/hosting-types.ts";
import type { PgQueryResult, PgRow, PostgreSQLClient } from "./client.ts";

type Query = (text: string, values?: unknown[]) => ResultAsync<PgQueryResult, StoreError>;

const retryable = (message: string): HostingError => ({ type: "hosting_retryable", message });
const storage = (error: StoreError): HostingError =>
  error.code === "corruption" || error.code === "invariant"
    ? { type: "hosting_corruption", message: "hosted-file storage is inconsistent" }
    : retryable("hosted-file storage is unavailable");
const conflict = (message: string): HostingError => ({ type: "hosting_conflict", message });
const unauthorized = (): HostingError => ({
  type: "hosting_unauthorized",
  message: "runtime identity rejected",
});

function toMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  return typeof value === "string" ? new Date(value).getTime() : 0;
}

function objectFrom(row: PgRow, prefix: string): HostedObjectRef | null {
  const key = row[prefix === "" ? "object_key" : `${prefix}_object_key`];
  const generation = row[prefix === "" ? "object_generation" : `${prefix}_object_generation`];
  return key == null || generation == null
    ? null
    : { key: String(key), generation: String(generation) };
}

function mapFile(row: PgRow, prefix = ""): HostedFile {
  const field = (name: string): unknown => row[prefix === "" ? name : `${prefix}_${name}`];
  return {
    orbId: String(field("orb_id")),
    path: String(field("path")),
    object: {
      key: String(field("object_key")),
      generation: String(field("object_generation")),
    },
    size: Number(field("size")),
    mediaType: String(field("media_type")),
    sha256: String(field("sha256")),
    createdAt: toMs(field("created_at")),
    updatedAt: toMs(field("updated_at")),
  };
}

function mapOperation(row: PgRow): HostingOperation {
  const request: HostingUploadRequest = {
    orbId: String(row["orb_id"]),
    runtimeTokenHash: String(row["runtime_token_hash"]),
    incarnation: Number(row["incarnation"]),
    requestId: String(row["request_id"]),
    path: String(row["path"]),
    size: Number(row["size"]),
    mediaType: String(row["media_type"]),
    sha256: String(row["sha256"]),
  };
  const state = String(row["state"]) as HostingOperation["state"];
  return {
    id: String(row["id"]),
    request,
    state,
    publishedFile:
      state !== "published"
        ? null
        : {
            orbId: request.orbId,
            path: request.path,
            object: {
              key: String(row["published_object_key"]),
              generation: String(row["published_object_generation"]),
            },
            size: request.size,
            mediaType: request.mediaType,
            sha256: request.sha256,
            createdAt: toMs(row["published_created_at"]),
            updatedAt: toMs(row["published_updated_at"]),
          },
  };
}

function mapAttempt(row: PgRow): HostingAttempt {
  const committed = objectFrom(row, "committed");
  return {
    id: String(row["id"]),
    operationId: String(row["operation_id"]),
    objectKey: String(row["object_key"]),
    epoch: Number(row["epoch"]),
    state: String(row["state"]) as HostingAttempt["state"],
    sessionId: row["session_id"] == null ? null : String(row["session_id"]),
    committedObject:
      committed === null
        ? null
        : {
            ref: committed,
            size: Number(row["committed_size"]),
            sha256: String(row["committed_sha256"]),
          },
  };
}

function mapCleanup(row: PgRow): HostingCleanupItem {
  return {
    id: String(row["id"]),
    orbId: String(row["orb_id"]),
    path: row["path"] == null ? null : String(row["path"]),
    sessionId: row["session_id"] == null ? null : String(row["session_id"]),
    object: objectFrom(row, ""),
  };
}

function sameRequest(row: PgRow, request: HostingUploadRequest): boolean {
  return (
    String(row["orb_id"]) === request.orbId &&
    String(row["request_id"]) === request.requestId &&
    String(row["runtime_token_hash"]) === request.runtimeTokenHash &&
    Number(row["incarnation"]) === request.incarnation &&
    String(row["path"]) === request.path &&
    Number(row["size"]) === request.size &&
    String(row["media_type"]) === request.mediaType &&
    String(row["sha256"]) === request.sha256
  );
}

function exactObject(left: HostedObjectRef, right: HostedObjectRef): boolean {
  return left.key === right.key && left.generation === right.generation;
}

/** PostgreSQL/PGlite implementation of the durable hosting catalog and ownership protocol. */
export class PostgreSQLHostingStore implements HostingStore {
  private readonly db: PostgreSQLClient;

  constructor(db: PostgreSQLClient) {
    this.db = db;
  }

  private transaction<T>(
    f: (query: Query) => Promise<Result<T, HostingError>>,
  ): ResultAsync<T, HostingError> {
    return this.db
      .transaction<T, HostingError>((query) => f(query))
      .mapErr((error) =>
        error.type === "hosting_invalid" ||
        error.type === "hosting_not_found" ||
        error.type === "hosting_too_large" ||
        error.type === "hosting_unauthorized" ||
        error.type === "hosting_conflict" ||
        error.type === "hosting_retryable" ||
        error.type === "hosting_corruption" ||
        error.type === "hosting_cancelled"
          ? error
          : error.code === "corruption" || error.code === "invariant"
            ? { type: "hosting_corruption", message: "hosted-file storage is inconsistent" }
            : retryable("hosted-file storage is unavailable"),
      );
  }

  private async authorize(
    query: Query,
    caller: { orbId: string; runtimeTokenHash: string; incarnation: number },
    state: "running" | "deleting",
  ): Promise<Result<void, HostingError>> {
    const found = await query(
      `SELECT state, runtime_token_hash, host_incarnation, host_discard_through_incarnation
         FROM orbs WHERE id = $1 FOR UPDATE`,
      [caller.orbId],
    );
    if (found.isErr()) return err(storage(found.error));
    const row = found.value.rows[0];
    if (row === undefined) return err(unauthorized());
    if (String(row["state"]) !== state) return err(conflict(`orb is not ${state}`));
    if (state === "running") {
      if (
        row["runtime_token_hash"] == null ||
        String(row["runtime_token_hash"]) !== caller.runtimeTokenHash ||
        Number(row["host_incarnation"]) !== caller.incarnation ||
        row["host_discard_through_incarnation"] !== null
      ) {
        return err(unauthorized());
      }
    }
    return ok(undefined);
  }

  private async lockAuthorizedOperation(
    query: Query,
    operationId: string,
  ): Promise<Result<PgRow, HostingError>> {
    const selected = await query("SELECT * FROM hosting_operations WHERE id = $1", [operationId]);
    if (selected.isErr()) return err(storage(selected.error));
    const row = selected.value.rows[0];
    if (row === undefined) return err(conflict("upload operation does not exist"));
    const auth = await this.authorize(query, mapOperation(row).request, "running");
    if (auth.isErr()) return err(auth.error);
    const locked = await query("SELECT * FROM hosting_operations WHERE id = $1 FOR UPDATE", [
      operationId,
    ]);
    if (locked.isErr()) return err(storage(locked.error));
    const lockedRow = locked.value.rows[0];
    return lockedRow === undefined
      ? err(conflict("upload operation does not exist"))
      : ok(lockedRow);
  }

  private async lockAuthorizedAttempt(
    query: Query,
    attemptId: string,
    epoch: number,
  ): Promise<Result<PgRow, HostingError>> {
    const selected = await query(
      `SELECT o.* FROM hosting_attempts a
         JOIN hosting_operations o ON o.id = a.operation_id WHERE a.id = $1`,
      [attemptId],
    );
    if (selected.isErr()) return err(storage(selected.error));
    const row = selected.value.rows[0];
    if (row === undefined) return err(conflict("upload attempt does not exist"));
    const auth = await this.authorize(query, mapOperation(row).request, "running");
    if (auth.isErr()) return err(auth.error);
    const locked = await query("SELECT * FROM hosting_attempts WHERE id = $1 FOR UPDATE", [
      attemptId,
    ]);
    if (locked.isErr()) return err(storage(locked.error));
    const lockedRow = locked.value.rows[0];
    if (lockedRow === undefined || Number(lockedRow["epoch"]) !== epoch) {
      return err(conflict("upload attempt claim is stale"));
    }
    const cleanup = await query("SELECT 1 FROM hosting_cleanup_items WHERE attempt_id = $1", [
      attemptId,
    ]);
    if (cleanup.isErr()) return err(storage(cleanup.error));
    return cleanup.value.rows.length > 0
      ? err(conflict("upload attempt is being cleaned"))
      : ok(lockedRow);
  }

  reserveUpload(
    _task: SimulationTask,
    request: HostingUploadRequest,
  ): ResultAsync<HostingOperation, HostingError> {
    return this.transaction(async (query) => {
      const auth = await this.authorize(query, request, "running");
      if (auth.isErr()) return err(auth.error);
      const existing = await query(
        "SELECT * FROM hosting_operations WHERE orb_id = $1 AND request_id = $2 FOR UPDATE",
        [request.orbId, request.requestId],
      );
      if (existing.isErr()) return err(storage(existing.error));
      const row = existing.value.rows[0];
      if (row !== undefined) {
        return sameRequest(row, request)
          ? ok(mapOperation(row))
          : err(conflict("request ID was already used with different upload parameters"));
      }
      const id = `${request.orbId}:${request.requestId}`;
      const inserted = await query(
        `INSERT INTO hosting_operations
           (id, orb_id, request_id, runtime_token_hash, incarnation, path, size, media_type,
            sha256, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'reserved') RETURNING *`,
        [
          id,
          request.orbId,
          request.requestId,
          request.runtimeTokenHash,
          request.incarnation,
          request.path,
          request.size,
          request.mediaType,
          request.sha256,
        ],
      );
      return inserted.isErr()
        ? err(storage(inserted.error))
        : ok(mapOperation(inserted.value.rows[0] as PgRow));
    });
  }

  claimUpload(
    _task: SimulationTask,
    params: {
      operationId: string;
      now: number;
      leaseUntil: number;
    },
  ): ResultAsync<
    | { type: "published"; file: HostedFile }
    | { type: "busy" }
    | { type: "claimed"; attempt: HostingAttempt; takeover: boolean },
    HostingError
  > {
    return this.transaction(async (query) => {
      const locked = await this.lockAuthorizedOperation(query, params.operationId);
      if (locked.isErr()) return err(locked.error);
      const operation = mapOperation(locked.value);
      if (operation.publishedFile !== null) {
        return ok({ type: "published" as const, file: operation.publishedFile });
      }
      const selectedAttempt = await query(
        "SELECT * FROM hosting_attempts WHERE operation_id = $1 FOR UPDATE",
        [operation.id],
      );
      if (selectedAttempt.isErr()) return err(storage(selectedAttempt.error));
      const current = selectedAttempt.value.rows[0];
      if (current !== undefined) {
        const cleanup = await query("SELECT 1 FROM hosting_cleanup_items WHERE attempt_id = $1", [
          String(current["id"]),
        ]);
        if (cleanup.isErr()) return err(storage(cleanup.error));
        if (cleanup.value.rows.length > 0) return ok({ type: "busy" as const });
        if (toMs(current["claim_until"]) > params.now) return ok({ type: "busy" as const });
        const reclaimed = await query(
          `UPDATE hosting_attempts SET epoch = epoch + 1,
             claim_until = $2, updated_at = $3 WHERE id = $1 RETURNING *`,
          [String(current["id"]), new Date(params.leaseUntil), new Date(params.now)],
        );
        return reclaimed.isErr()
          ? err(storage(reclaimed.error))
          : ok({
              type: "claimed" as const,
              attempt: mapAttempt(reclaimed.value.rows[0] as PgRow),
              takeover: true,
            });
      }

      const numbered = await query(
        `UPDATE hosting_operations SET next_attempt = next_attempt + 1, state = 'uploading',
           updated_at = $2 WHERE id = $1 RETURNING next_attempt`,
        [operation.id, new Date(params.now)],
      );
      if (numbered.isErr()) return err(storage(numbered.error));
      const number = Number(numbered.value.rows[0]?.["next_attempt"]);
      const attemptId = `${operation.id}:attempt:${number}`;
      const inserted = await query(
        `INSERT INTO hosting_attempts
           (id, operation_id, object_key, epoch, state, claim_until, updated_at)
         VALUES ($1, $2, $3, 1, 'beginning', $4, $5) RETURNING *`,
        [
          attemptId,
          operation.id,
          `${operation.request.orbId}/operations/${operation.request.requestId}/attempt-${number}`,
          new Date(params.leaseUntil),
          new Date(params.now),
        ],
      );
      return inserted.isErr()
        ? err(storage(inserted.error))
        : ok({
            type: "claimed" as const,
            attempt: mapAttempt(inserted.value.rows[0] as PgRow),
            takeover: false,
          });
    });
  }

  abandonEmptyAttempt(
    _task: SimulationTask,
    attemptId: string,
    epoch: number,
  ): ResultAsync<void, HostingError> {
    return this.transaction(async (query) => {
      const removed = await query(
        "DELETE FROM hosting_attempts WHERE id = $1 AND epoch = $2 RETURNING operation_id",
        [attemptId, epoch],
      );
      if (removed.isErr()) return err(storage(removed.error));
      const operationId = removed.value.rows[0]?.["operation_id"];
      if (operationId === undefined) return err(conflict("upload attempt claim is stale"));
      const reset = await query(
        "UPDATE hosting_operations SET state = 'reserved' WHERE id = $1 AND state <> 'published'",
        [String(operationId)],
      );
      return reset.isErr() ? err(storage(reset.error)) : ok(undefined);
    });
  }

  registerSession(
    _task: SimulationTask,
    attemptId: string,
    epoch: number,
    sessionId: string,
  ): ResultAsync<HostingAttempt, HostingError> {
    return this.transaction(async (query) => {
      const locked = await this.lockAuthorizedAttempt(query, attemptId, epoch);
      if (locked.isErr()) return err(locked.error);
      const row = locked.value;
      if (String(row["state"]) !== "beginning") {
        return String(row["session_id"]) === sessionId
          ? ok(mapAttempt(row))
          : err(conflict("upload attempt already has a different session"));
      }
      const updated = await query(
        `UPDATE hosting_attempts SET state = 'session_ready', session_id = $3,
           updated_at = now() WHERE id = $1 AND epoch = $2 RETURNING *`,
        [attemptId, epoch, sessionId],
      );
      return updated.isErr()
        ? err(storage(updated.error))
        : ok(mapAttempt(updated.value.rows[0] as PgRow));
    });
  }

  recordCommit(
    _task: SimulationTask,
    attemptId: string,
    epoch: number,
    object: StoredHostedObject,
  ): ResultAsync<HostingAttempt, HostingError> {
    return this.transaction(async (query) => {
      const locked = await this.lockAuthorizedAttempt(query, attemptId, epoch);
      if (locked.isErr()) return err(locked.error);
      const row = locked.value;
      if (String(row["state"]) === "committed") {
        const current = mapAttempt(row).committedObject;
        return current !== null &&
          exactObject(current.ref, object.ref) &&
          current.size === object.size &&
          current.sha256 === object.sha256
          ? ok(mapAttempt(row))
          : err(conflict("upload attempt already committed different bytes"));
      }
      if (String(row["state"]) !== "session_ready") {
        return err(conflict("upload session is not registered"));
      }
      const updated = await query(
        `UPDATE hosting_attempts SET state = 'committed', committed_object_key = $3,
           committed_object_generation = $4, committed_size = $5, committed_sha256 = $6,
           updated_at = now() WHERE id = $1 AND epoch = $2 RETURNING *`,
        [attemptId, epoch, object.ref.key, object.ref.generation, object.size, object.sha256],
      );
      return updated.isErr()
        ? err(storage(updated.error))
        : ok(mapAttempt(updated.value.rows[0] as PgRow));
    });
  }

  publishUpload(
    _task: SimulationTask,
    operationId: string,
    attemptId: string,
    epoch: number,
    now: number,
  ): ResultAsync<HostedFile, HostingError> {
    return this.transaction(async (query) => {
      const locked = await this.lockAuthorizedOperation(query, operationId);
      if (locked.isErr()) return err(locked.error);
      const operation = mapOperation(locked.value);
      if (operation.publishedFile !== null) return ok(operation.publishedFile);
      const selectedAttempt = await query(
        "SELECT * FROM hosting_attempts WHERE id = $1 AND operation_id = $2 FOR UPDATE",
        [attemptId, operationId],
      );
      if (selectedAttempt.isErr()) return err(storage(selectedAttempt.error));
      const row = selectedAttempt.value.rows[0];
      if (
        row === undefined ||
        Number(row["epoch"]) !== epoch ||
        String(row["state"]) !== "committed"
      ) {
        return err(conflict("upload attempt is not publishable"));
      }
      const attempt = mapAttempt(row);
      const stored = attempt.committedObject;
      if (
        stored === null ||
        stored.size !== operation.request.size ||
        stored.sha256 !== operation.request.sha256
      ) {
        return err({ type: "hosting_corruption", message: "committed object metadata differs" });
      }
      const previous = await query(
        "SELECT * FROM hosted_files WHERE orb_id = $1 AND path = $2 FOR UPDATE",
        [operation.request.orbId, operation.request.path],
      );
      if (previous.isErr()) return err(storage(previous.error));
      const oldRow = previous.value.rows[0];
      if (oldRow !== undefined) {
        const old = mapFile(oldRow);
        const retired = await query(
          `INSERT INTO hosting_cleanup_items
             (id, orb_id, operation_id, path, object_key, object_generation)
           VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
          [
            `retired:${old.orbId}:${old.object.key}@${old.object.generation}`,
            old.orbId,
            operation.id,
            operation.request.path,
            old.object.key,
            old.object.generation,
          ],
        );
        if (retired.isErr()) return err(storage(retired.error));
      }
      const createdAt = oldRow === undefined ? now : toMs(oldRow["created_at"]);
      const upserted = await query(
        `INSERT INTO hosted_files
           (orb_id, path, object_key, object_generation, size, media_type, sha256,
            created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (orb_id, path) DO UPDATE SET object_key = EXCLUDED.object_key,
           object_generation = EXCLUDED.object_generation, size = EXCLUDED.size,
           media_type = EXCLUDED.media_type, sha256 = EXCLUDED.sha256,
           updated_at = EXCLUDED.updated_at RETURNING *`,
        [
          operation.request.orbId,
          operation.request.path,
          stored.ref.key,
          stored.ref.generation,
          stored.size,
          operation.request.mediaType,
          stored.sha256,
          new Date(createdAt),
          new Date(now),
        ],
      );
      if (upserted.isErr()) return err(storage(upserted.error));
      const file = mapFile(upserted.value.rows[0] as PgRow);
      const published = await query(
        `UPDATE hosting_operations SET state = 'published', published_object_key = $2,
           published_object_generation = $3, published_created_at = $4,
           published_updated_at = $5, updated_at = $5 WHERE id = $1`,
        [
          operationId,
          file.object.key,
          file.object.generation,
          new Date(file.createdAt),
          new Date(file.updatedAt),
        ],
      );
      if (published.isErr()) return err(storage(published.error));
      const event = await query(
        `INSERT INTO hosting_events
           (event_key, orb_id, event_type, path, operation_id, object_key,
            object_generation, caller_incarnation, created_at)
         VALUES ($1, $2, 'published', $3, $4, $5, $6, $7, $8)
         ON CONFLICT (event_key) DO NOTHING`,
        [
          `published:${operationId}`,
          operation.request.orbId,
          operation.request.path,
          operationId,
          file.object.key,
          file.object.generation,
          operation.request.incarnation,
          new Date(now),
        ],
      );
      if (event.isErr()) return err(storage(event.error));
      const removed = await query("DELETE FROM hosting_attempts WHERE id = $1", [attemptId]);
      return removed.isErr() ? err(storage(removed.error)) : ok(file);
    });
  }

  listFiles(_task: SimulationTask, orbId: string): ResultAsync<HostedFile[], HostingError> {
    return this.db
      .query("SELECT * FROM hosted_files WHERE orb_id = $1 ORDER BY path", [orbId])
      .map((result) => result.rows.map((row) => mapFile(row)))
      .mapErr(storage);
  }

  getInventory(
    _task: SimulationTask,
    orbId: string,
  ): ResultAsync<HostedFileInventory, HostingError> {
    return this.transaction(async (query) => {
      const files = await query("SELECT * FROM hosted_files WHERE orb_id = $1 ORDER BY path", [
        orbId,
      ]);
      if (files.isErr()) return err(storage(files.error));
      const issues = await query(
        `SELECT path, last_error, last_error_at FROM hosting_cleanup_items
          WHERE orb_id = $1 AND last_error IS NOT NULL ORDER BY last_error_at, id`,
        [orbId],
      );
      if (issues.isErr()) return err(storage(issues.error));
      return ok({
        files: files.value.rows.map((row) => mapFile(row)),
        cleanupIssues: issues.value.rows.map((row) => ({
          path: row["path"] == null ? null : String(row["path"]),
          lastError: String(row["last_error"]),
          lastErrorAt: toMs(row["last_error_at"]),
        })),
      });
    });
  }

  resolveFile(
    _task: SimulationTask,
    orbId: string,
    path: string,
  ): ResultAsync<HostedFile | null, HostingError> {
    return this.db
      .query("SELECT * FROM hosted_files WHERE orb_id = $1 AND path = $2", [orbId, path])
      .map((result) => (result.rows[0] === undefined ? null : mapFile(result.rows[0])))
      .mapErr(storage);
  }

  unpublishExact(
    _task: SimulationTask,
    caller: { orbId: string; runtimeTokenHash: string; incarnation: number },
    path: string,
    expected: HostedObjectRef | undefined,
  ): ResultAsync<void, HostingError> {
    return this.transaction(async (query) => {
      const auth = await this.authorize(query, caller, "running");
      if (auth.isErr()) return err(auth.error);
      const selected = await query(
        "SELECT * FROM hosted_files WHERE orb_id = $1 AND path = $2 FOR UPDATE",
        [caller.orbId, path],
      );
      if (selected.isErr()) return err(storage(selected.error));
      const row = selected.value.rows[0];
      if (row === undefined) return ok(undefined);
      const file = mapFile(row);
      if (expected !== undefined && !exactObject(file.object, expected)) return ok(undefined);
      const itemId = `removed:${file.orbId}:${file.object.key}@${file.object.generation}`;
      const queued = await query(
        `INSERT INTO hosting_cleanup_items (id, orb_id, path, object_key, object_generation)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
        [itemId, file.orbId, file.path, file.object.key, file.object.generation],
      );
      if (queued.isErr()) return err(storage(queued.error));
      const event = await query(
        `INSERT INTO hosting_events
           (event_key, orb_id, event_type, path, cleanup_item_id, object_key,
            object_generation, caller_incarnation, created_at)
         VALUES ($1, $2, 'removed', $3, $4, $5, $6, $7, now())
         ON CONFLICT (event_key) DO NOTHING`,
        [
          `removed:${itemId}`,
          file.orbId,
          file.path,
          itemId,
          file.object.key,
          file.object.generation,
          caller.incarnation,
        ],
      );
      if (event.isErr()) return err(storage(event.error));
      const removed = await query("DELETE FROM hosted_files WHERE orb_id = $1 AND path = $2", [
        caller.orbId,
        path,
      ]);
      return removed.isErr() ? err(storage(removed.error)) : ok(undefined);
    });
  }

  beginOrbCleanup(_task: SimulationTask, orbId: string): ResultAsync<void, HostingError> {
    return this.transaction(async (query) => {
      const auth = await this.authorize(
        query,
        { orbId, runtimeTokenHash: "", incarnation: 0 },
        "deleting",
      );
      if (auth.isErr()) return err(auth.error);
      const attempts = await query(
        `INSERT INTO hosting_cleanup_items
           (id, orb_id, attempt_id, operation_id, path, session_id, object_key, object_generation)
         SELECT 'attempt:' || a.id, o.orb_id, a.id, o.id, o.path, a.session_id,
                a.committed_object_key, a.committed_object_generation
           FROM hosting_attempts a JOIN hosting_operations o ON o.id = a.operation_id
          WHERE o.orb_id = $1
         ON CONFLICT (id) DO NOTHING`,
        [orbId],
      );
      if (attempts.isErr()) return err(storage(attempts.error));
      const files = await query(
        `INSERT INTO hosting_cleanup_items (id, orb_id, path, object_key, object_generation)
         SELECT 'file:' || orb_id::text || ':' || path, orb_id, path, object_key, object_generation
           FROM hosted_files WHERE orb_id = $1 ON CONFLICT (id) DO NOTHING`,
        [orbId],
      );
      if (files.isErr()) return err(storage(files.error));
      const unpublished = await query("DELETE FROM hosted_files WHERE orb_id = $1", [orbId]);
      if (unpublished.isErr()) return err(storage(unpublished.error));
      return ok(undefined);
    });
  }

  claimCleanup(
    _task: SimulationTask,
    params: { orbId?: string; now: number; leaseUntil: number; limit: number },
  ): ResultAsync<HostingCleanupClaim[], HostingError> {
    return this.transaction(async (query) => {
      const candidates = await query(
        `SELECT a.id AS attempt_id, o.id AS operation_id, o.orb_id
           FROM hosting_attempts a JOIN hosting_operations o ON o.id = a.operation_id
          WHERE a.claim_until <= $1 AND o.state <> 'published'
            AND ($2::uuid IS NULL OR o.orb_id = $2)`,
        [new Date(params.now), params.orbId ?? null],
      );
      if (candidates.isErr()) return err(storage(candidates.error));
      for (const orbId of [
        ...new Set(candidates.value.rows.map((row) => String(row["orb_id"]))),
      ].sort()) {
        const locked = await query("SELECT id FROM orbs WHERE id = $1 FOR UPDATE", [orbId]);
        if (locked.isErr()) return err(storage(locked.error));
      }
      for (const operationId of [
        ...new Set(candidates.value.rows.map((row) => String(row["operation_id"]))),
      ].sort()) {
        const locked = await query("SELECT id FROM hosting_operations WHERE id = $1 FOR UPDATE", [
          operationId,
        ]);
        if (locked.isErr()) return err(storage(locked.error));
      }
      for (const attemptId of [
        ...new Set(candidates.value.rows.map((row) => String(row["attempt_id"]))),
      ].sort()) {
        const locked = await query("SELECT id FROM hosting_attempts WHERE id = $1 FOR UPDATE", [
          attemptId,
        ]);
        if (locked.isErr()) return err(storage(locked.error));
      }
      const expired = await query(
        `INSERT INTO hosting_cleanup_items
           (id, orb_id, attempt_id, operation_id, path, session_id, object_key, object_generation)
         SELECT 'attempt:' || a.id, o.orb_id, a.id, o.id, o.path, a.session_id,
                a.committed_object_key, a.committed_object_generation
           FROM hosting_attempts a JOIN hosting_operations o ON o.id = a.operation_id
          WHERE a.claim_until <= $1 AND o.state <> 'published'
            AND ($2::uuid IS NULL OR o.orb_id = $2)
         ON CONFLICT (id) DO NOTHING`,
        [new Date(params.now), params.orbId ?? null],
      );
      if (expired.isErr()) return err(storage(expired.error));
      const selected = await query(
        `SELECT * FROM hosting_cleanup_items
          WHERE ($1::uuid IS NULL OR orb_id = $1)
            AND (claim_until IS NULL OR claim_until <= $2)
          ORDER BY created_at, id FOR UPDATE LIMIT $3`,
        [params.orbId ?? null, new Date(params.now), params.limit],
      );
      if (selected.isErr()) return err(storage(selected.error));
      const claims: HostingCleanupClaim[] = [];
      for (const row of selected.value.rows) {
        const updated = await query(
          `UPDATE hosting_cleanup_items SET claim_until = $2,
             claim_epoch = claim_epoch + 1 WHERE id = $1 RETURNING *`,
          [String(row["id"]), new Date(params.leaseUntil)],
        );
        if (updated.isErr()) return err(storage(updated.error));
        const claimed = updated.value.rows[0] as PgRow;
        claims.push({ ...mapCleanup(claimed), epoch: Number(claimed["claim_epoch"]) });
      }
      return ok(claims);
    });
  }

  finishClaimedCleanup(
    task: SimulationTask,
    itemId: string,
    epoch: number,
  ): ResultAsync<void, HostingError> {
    return this.finishItem(itemId, epoch, task.wallNow());
  }

  private finishItem(itemId: string, epoch: number, now: number): ResultAsync<void, HostingError> {
    return this.transaction(async (query) => {
      const owner = await query("SELECT * FROM hosting_cleanup_items WHERE id = $1", [itemId]);
      if (owner.isErr()) return err(storage(owner.error));
      const known = owner.value.rows[0];
      if (known === undefined) return err(conflict("cleanup claim is stale"));
      const orbLock = await query("SELECT id FROM orbs WHERE id = $1 FOR UPDATE", [
        known["orb_id"],
      ]);
      if (orbLock.isErr()) return err(storage(orbLock.error));
      if (known["operation_id"] !== null) {
        const operationLock = await query(
          "SELECT id FROM hosting_operations WHERE id = $1 FOR UPDATE",
          [known["operation_id"]],
        );
        if (operationLock.isErr()) return err(storage(operationLock.error));
      }
      if (known["attempt_id"] !== null) {
        const attemptLock = await query(
          "SELECT id FROM hosting_attempts WHERE id = $1 FOR UPDATE",
          [known["attempt_id"]],
        );
        if (attemptLock.isErr()) return err(storage(attemptLock.error));
      }
      const selected = await query("SELECT * FROM hosting_cleanup_items WHERE id = $1 FOR UPDATE", [
        itemId,
      ]);
      if (selected.isErr()) return err(storage(selected.error));
      const row = selected.value.rows[0];
      if (row === undefined) return err(conflict("cleanup claim is stale"));
      if (Number(row["claim_epoch"]) !== epoch) {
        return err(conflict("cleanup claim is stale"));
      }
      const event = await query(
        `INSERT INTO hosting_events
           (event_key, orb_id, event_type, path, operation_id, cleanup_item_id,
            object_key, object_generation, created_at)
         VALUES ($1, $2, 'cleanup_completed', $3, $4, $5, $6, $7, $8)
         ON CONFLICT (event_key) DO NOTHING`,
        [
          `cleanup-completed:${itemId}`,
          row["orb_id"],
          row["path"],
          row["operation_id"],
          itemId,
          row["object_key"],
          row["object_generation"],
          new Date(now),
        ],
      );
      if (event.isErr()) return err(storage(event.error));
      const attemptId = row["attempt_id"] == null ? null : String(row["attempt_id"]);
      const removed = await query("DELETE FROM hosting_cleanup_items WHERE id = $1", [itemId]);
      if (removed.isErr()) return err(storage(removed.error));
      if (attemptId !== null) {
        const attempt = await query(
          "DELETE FROM hosting_attempts WHERE id = $1 RETURNING operation_id",
          [attemptId],
        );
        if (attempt.isErr()) return err(storage(attempt.error));
        const operationId = attempt.value.rows[0]?.["operation_id"];
        if (operationId !== undefined) {
          const reset = await query(
            "UPDATE hosting_operations SET state = 'reserved' WHERE id = $1 AND state <> 'published'",
            [String(operationId)],
          );
          if (reset.isErr()) return err(storage(reset.error));
        }
      }
      return ok(undefined);
    });
  }

  recordCleanupFailure(
    _task: SimulationTask,
    itemId: string,
    epoch: number,
    message: string,
    now: number,
  ): ResultAsync<void, HostingError> {
    return this.transaction(async (query) => {
      const updated = await query(
        `UPDATE hosting_cleanup_items SET last_error = $3, last_error_at = $4
          WHERE id = $1 AND claim_epoch = $2 AND last_error IS DISTINCT FROM $3
          RETURNING *`,
        [itemId, epoch, message, new Date(now)],
      );
      if (updated.isErr()) return err(storage(updated.error));
      const row = updated.value.rows[0];
      if (row === undefined) {
        const current = await query("SELECT claim_epoch FROM hosting_cleanup_items WHERE id = $1", [
          itemId,
        ]);
        if (current.isErr()) return err(storage(current.error));
        if (Number(current.value.rows[0]?.["claim_epoch"]) !== epoch) {
          return err(conflict("cleanup claim is stale"));
        }
        return ok(undefined);
      }
      const event = await query(
        `INSERT INTO hosting_events
           (event_key, orb_id, event_type, path, operation_id, cleanup_item_id,
            object_key, object_generation, message, created_at)
         VALUES ($1, $2, 'cleanup_blocked', $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (event_key) DO NOTHING`,
        [
          `cleanup-blocked:${itemId}:${epoch}:${message}`,
          row["orb_id"],
          row["path"],
          row["operation_id"],
          itemId,
          row["object_key"],
          row["object_generation"],
          message,
          new Date(now),
        ],
      );
      return event.isErr() ? err(storage(event.error)) : ok(undefined);
    });
  }

  recordCleanupObject(
    _task: SimulationTask,
    itemId: string,
    epoch: number,
    object: HostedObjectRef,
  ): ResultAsync<void, HostingError> {
    return this.transaction(async (query) => {
      const updated = await query(
        `UPDATE hosting_cleanup_items
            SET object_key = $3, object_generation = $4
          WHERE id = $1 AND claim_epoch = $2
            AND (object_key IS NULL OR (object_key = $3 AND object_generation = $4))
          RETURNING id`,
        [itemId, epoch, object.key, object.generation],
      );
      if (updated.isErr()) return err(storage(updated.error));
      if (updated.value.rows[0] !== undefined) return ok(undefined);
      return err(conflict("cleanup claim is stale or its object generation differs"));
    });
  }

  finishOrbCleanup(_task: SimulationTask, orbId: string): ResultAsync<void, HostingError> {
    return this.transaction(async (query) => {
      const auth = await this.authorize(
        query,
        { orbId, runtimeTokenHash: "", incarnation: 0 },
        "deleting",
      );
      if (auth.isErr()) return err(auth.error);
      const owners = await query(
        `SELECT
           (SELECT count(*) FROM hosting_cleanup_items WHERE orb_id = $1) AS cleanup_count,
           (SELECT count(*) FROM hosted_files WHERE orb_id = $1) AS file_count`,
        [orbId],
      );
      if (owners.isErr()) return err(storage(owners.error));
      const row = owners.value.rows[0];
      if (Number(row?.["cleanup_count"]) !== 0 || Number(row?.["file_count"]) !== 0) {
        return err(conflict("hosted-file cleanup remains"));
      }
      const attempts = await query(
        `DELETE FROM hosting_attempts WHERE operation_id IN
           (SELECT id FROM hosting_operations WHERE orb_id = $1)`,
        [orbId],
      );
      if (attempts.isErr()) return err(storage(attempts.error));
      const operations = await query("DELETE FROM hosting_operations WHERE orb_id = $1", [orbId]);
      return operations.isErr() ? err(storage(operations.error)) : ok(undefined);
    });
  }
}

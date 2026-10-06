import { createHash } from "node:crypto";
import { err, ok, type ResultAsync } from "neverthrow";
import { z } from "zod";
import type { StoreError } from "../../domain/errors.ts";
import {
  type ResourceError,
  type ResourceSnapshot,
  type ResourceSnapshotStore,
  resourceError,
} from "../../domain/resources.ts";
import { jsonParam, type PgQueryResult, type PostgreSQLClient } from "./client.ts";

const resourceManifest = z.object({
  instructionPath: z.string().nullable(),
  skillRoot: z.string().nullable(),
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(1024),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        byteCount: z.number().int().nonnegative(),
      }),
    )
    .max(5000),
});
function invalidSnapshot(): StoreError {
  return {
    type: "store_error",
    code: "corruption",
    message: "Invalid persisted resource snapshot",
    retryable: false,
  };
}
export type ResourceQuery = (
  sql: string,
  values?: unknown[],
) => ResultAsync<PgQueryResult, StoreError>;
export function removeResourceSnapshot(
  query: ResourceQuery,
  orbId: string,
): ResultAsync<void, StoreError> {
  return query("SELECT id FROM orbs WHERE id=$1 FOR UPDATE", [orbId])
    .andThen(() => query("DELETE FROM orb_resource_snapshots WHERE orb_id=$1", [orbId]))
    .map(() => undefined);
}
function load(
  query: ResourceQuery,
  orbId: string,
): ResultAsync<ResourceSnapshot | null, StoreError> {
  return query("SELECT commit_sha,manifest FROM orb_resource_snapshots WHERE orb_id=$1", [
    orbId,
  ]).andThen((result) => {
    const row = result.rows[0];
    if (!row) return ok(null);
    const parsed = resourceManifest.safeParse(row.manifest);
    if (
      !parsed.success ||
      typeof row.commit_sha !== "string" ||
      !/^[a-f0-9]{40}$/.test(row.commit_sha)
    )
      return err(invalidSnapshot());
    const manifest = parsed.data;
    return query("SELECT path,bytes,sha256 FROM orb_resource_files WHERE orb_id=$1 ORDER BY path", [
      orbId,
    ]).andThen((files) => {
      if (files.rows.length !== manifest.files.length) return err(invalidSnapshot());
      const decoded: ResourceSnapshot["files"] = [];
      for (const file of files.rows) {
        const expected = manifest.files.find((entry) => entry.path === file.path);
        if (
          !expected ||
          !(file.bytes instanceof Uint8Array) ||
          file.bytes.byteLength !== expected.byteCount ||
          file.sha256 !== expected.sha256 ||
          createHash("sha256").update(file.bytes).digest("hex") !== expected.sha256
        )
          return err(invalidSnapshot());
        decoded.push({
          path: expected.path,
          bytes: Buffer.from(file.bytes),
          sha256: expected.sha256,
        });
      }
      return ok({
        orbId,
        commitSha: row.commit_sha as string,
        instructionPath: manifest.instructionPath,
        skillRoot: manifest.skillRoot,
        files: decoded,
      });
    });
  });
}
export type ResourcePublicationGuard = (
  query: ResourceQuery,
  orbId: string,
) => ResultAsync<void, StoreError>;
export class PgResourceSnapshots implements ResourceSnapshotStore {
  private readonly client: PostgreSQLClient;
  private readonly publicationGuard: ResourcePublicationGuard | undefined;
  constructor(client: PostgreSQLClient, publicationGuard?: ResourcePublicationGuard) {
    this.client = client;
    this.publicationGuard = publicationGuard;
  }
  get(orbId: string): ResultAsync<ResourceSnapshot | null, ResourceError> {
    return this.client
      .transaction<ResourceSnapshot | null, StoreError>(async (query) => {
        const lock = await query("SELECT id FROM orbs WHERE id=$1 FOR SHARE", [orbId]);
        if (lock.isErr()) return err(lock.error);
        return await load(query, orbId);
      })
      .mapErr(() => resourceError("storage", "Resource snapshot read failed"));
  }
  put(snapshot: ResourceSnapshot): ResultAsync<ResourceSnapshot, ResourceError> {
    return this.client
      .transaction<ResourceSnapshot, StoreError>(async (query) => {
        const lock = await query("SELECT id FROM orbs WHERE id=$1 FOR UPDATE", [snapshot.orbId]);
        if (lock.isErr()) return err(lock.error);
        if (this.publicationGuard) {
          const admitted = await this.publicationGuard(query, snapshot.orbId);
          if (admitted.isErr()) return err(admitted.error);
        }
        const existing = await load(query, snapshot.orbId);
        if (existing.isErr()) return err(existing.error);
        if (existing.value) return ok(existing.value);
        const manifest = {
          instructionPath: snapshot.instructionPath,
          skillRoot: snapshot.skillRoot,
          files: snapshot.files.map((file) => ({
            path: file.path,
            sha256: file.sha256,
            byteCount: file.bytes.byteLength,
          })),
        };
        const inserted = await query(
          "INSERT INTO orb_resource_snapshots(orb_id,commit_sha,manifest) VALUES($1,$2,$3)",
          [snapshot.orbId, snapshot.commitSha, jsonParam(manifest)],
        );
        if (inserted.isErr()) return err(inserted.error);
        for (const file of snapshot.files) {
          const result = await query(
            "INSERT INTO orb_resource_files(orb_id,path,bytes,sha256) VALUES($1,$2,$3,$4)",
            [snapshot.orbId, file.path, Buffer.from(file.bytes), file.sha256],
          );
          if (result.isErr()) return err(result.error);
        }
        if (this.publicationGuard) {
          const admitted = await this.publicationGuard(query, snapshot.orbId);
          if (admitted.isErr()) return err(admitted.error);
        }
        return ok(snapshot);
      })
      .mapErr(() => resourceError("storage", "Resource snapshot commit failed"));
  }
  remove(orbId: string): ResultAsync<void, ResourceError> {
    return this.client
      .transaction(async (query) => removeResourceSnapshot(query, orbId))
      .mapErr(() => resourceError("storage", "Resource snapshot cleanup failed"));
  }
}

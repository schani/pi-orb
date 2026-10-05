import { createHash } from "node:crypto";
import { err, ok, Result, ResultAsync } from "neverthrow";
import type {
  MaintenanceError,
  MaintenanceReceipt,
  MaintenanceSnapshot,
} from "../domain/maintenance.ts";
import type { GcsTokenProvider } from "./hosting/gcs.ts";

export interface MaintenanceBinding {
  releaseId: string;
  executionId: string;
  sourceSha: string;
  mode: "inventory" | "drain" | "resume";
  phase: "before" | "drain" | "final" | "preapply-resume";
}
export const safeMaintenanceId = (value: string): boolean =>
  /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
const failure = (): MaintenanceError => ({ type: "maintenance_error", code: "storage" });
const hash = (body: string): string => createHash("sha256").update(body).digest("hex");
const MAX_BYTES = 256 * 1024;
const orbFields = [
  "id",
  "projectId",
  "state",
  "stateVersion",
  "hostRef",
  "hostIncarnation",
  "replicationCursor",
  "replicatedHeadId",
  "sleepId",
  "sleepUntil",
  "discardThrough",
  "disposal",
  "historySealedAt",
  "cleanupAfter",
] as const;
export function privateMaintenanceSnapshot(snapshot: MaintenanceSnapshot): MaintenanceSnapshot {
  return {
    releaseId: snapshot.releaseId,
    phase: snapshot.phase,
    projects: snapshot.projects.map(({ id, ownerUserId }) => ({ id, ownerUserId })),
    orbs: snapshot.orbs.map((orb) => ({
      ...Object.fromEntries(orbFields.map((field) => [field, orb[field]])),
      messages: orb.messages.map(({ id, wake }) => ({ id, wake })),
    })) as MaintenanceSnapshot["orbs"],
    resumeCandidates: snapshot.resumeCandidates.map(({ orbId, stateVersion }) => ({
      orbId,
      stateVersion,
    })),
  };
}
export function maintenanceCounts(snapshot: MaintenanceSnapshot): Record<string, number> {
  return {
    projects: snapshot.projects.length,
    orbs: snapshot.orbs.length,
    resumeCandidates: snapshot.resumeCandidates.length,
  };
}
export function createMaintenanceReceipts(options: {
  bucket: string;
  binding: MaintenanceBinding;
  auth: GcsTokenProvider;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}) {
  const request = options.fetch ?? fetch;
  const prefix = `release-maintenance/${options.binding.releaseId}/`;
  const headers = async () => {
    const token = await options.auth.getAccessToken();
    return token === null
      ? null
      : { authorization: `Bearer ${token}`, "content-type": "application/json" };
  };
  const boundary = async <T>(run: () => Promise<Result<T, MaintenanceError>>) => {
    const result = await ResultAsync.fromPromise(run(), failure);
    return result.isErr() ? err(result.error) : result.value;
  };
  return {
    seal: (
      key: string,
      snapshot: MaintenanceSnapshot,
      counts = maintenanceCounts(snapshot),
    ): Promise<Result<MaintenanceReceipt, MaintenanceError>> =>
      boundary(async () => {
        if (!safeMaintenanceId(key) || snapshot.releaseId !== options.binding.releaseId)
          return err(failure());
        const object = `${prefix}${options.binding.phase}/${options.binding.executionId}${key === "result" ? "" : `-${key}`}.json`;
        const { releaseId, executionId, sourceSha, mode, phase } = options.binding;
        const body = JSON.stringify({
          schemaVersion: 1,
          releaseId,
          executionId,
          sourceSha,
          mode,
          phase,
          snapshot: privateMaintenanceSnapshot(snapshot),
          counts,
          outcome: "sealed",
        });
        if (Buffer.byteLength(body) > MAX_BYTES) return err(failure());
        const authorization = await headers();
        if (authorization === null) return err(failure());
        const url = new URL(
          `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(options.bucket)}/o`,
        );
        url.searchParams.set("uploadType", "media");
        url.searchParams.set("name", object);
        url.searchParams.set("ifGenerationMatch", "0");
        const response = await request(url, {
          method: "POST",
          headers: authorization,
          body,
          signal: options.signal ?? AbortSignal.timeout(30_000),
        });
        if (!response.ok) return err(failure());
        const metadata = (await response.json()) as { generation?: unknown };
        if (typeof metadata.generation !== "string" || !/^[1-9][0-9]*$/.test(metadata.generation))
          return err(failure());
        return ok({
          receiptUri: `gs://${options.bucket}/${object}`,
          generation: metadata.generation,
          sha256: hash(body),
        });
      }),
    read: (
      reference: MaintenanceReceipt,
      phase: "drain" | "final",
    ): Promise<Result<MaintenanceSnapshot, MaintenanceError>> =>
      boundary(async () => {
        const expected = `gs://${options.bucket}/${prefix}${phase}/`;
        if (
          !reference.receiptUri.startsWith(expected) ||
          !/^[1-9][0-9]*$/.test(reference.generation) ||
          !/^[a-f0-9]{64}$/.test(reference.sha256)
        )
          return err(failure());
        const object = reference.receiptUri.slice(`gs://${options.bucket}/`.length);
        if (!/^[a-zA-Z0-9_/-]+\.json$/.test(object) || object.includes("..")) return err(failure());
        const authorization = await headers();
        if (authorization === null) return err(failure());
        const url = new URL(
          `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(options.bucket)}/o/${encodeURIComponent(object)}`,
        );
        url.searchParams.set("generation", reference.generation);
        url.searchParams.set("alt", "media");
        const response = await request(url, {
          headers: authorization,
          signal: options.signal ?? AbortSignal.timeout(30_000),
        });
        if (!response.ok || response.body === null) return err(failure());
        const reader = response.body.getReader();
        let body = "";
        let bytes = 0;
        const chunks: Uint8Array[] = [];
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > MAX_BYTES) {
            await reader.cancel();
            return err(failure());
          }
          chunks.push(next.value);
        }
        body = Buffer.concat(chunks).toString("utf8");
        if (hash(body) !== reference.sha256) return err(failure());
        const parsed = Result.fromThrowable(() => JSON.parse(body), failure)();
        if (parsed.isErr()) return err(failure());
        const envelope = parsed.value;
        if (
          envelope.schemaVersion !== 1 ||
          envelope.releaseId !== options.binding.releaseId ||
          envelope.sourceSha !== options.binding.sourceSha ||
          envelope.phase !== phase ||
          envelope.outcome !== "sealed" ||
          !safeMaintenanceId(envelope.executionId ?? "") ||
          envelope.snapshot?.releaseId !== envelope.releaseId ||
          envelope.snapshot?.phase !== phase
        )
          return err(failure());
        const projected = Result.fromThrowable(
          () => privateMaintenanceSnapshot(envelope.snapshot),
          failure,
        )();
        if (
          projected.isErr() ||
          JSON.stringify(projected.value) !== JSON.stringify(envelope.snapshot)
        )
          return err(failure());
        const states = [
          "creating",
          "starting",
          "running",
          "stopping",
          "stopped",
          "failed",
          "archiving",
          "archived",
          "deleting",
        ];
        for (const project of projected.value.projects)
          if (typeof project.id !== "string" || typeof project.ownerUserId !== "string")
            return err(failure());
        for (const row of projected.value.orbs) {
          if (
            !states.includes(row.state) ||
            typeof row.projectId !== "string" ||
            !["hostRef", "replicationCursor", "replicatedHeadId", "sleepId"].every((field) => {
              const value = (row as unknown as Record<string, unknown>)[field];
              return value === null || typeof value === "string";
            }) ||
            !["sleepUntil", "discardThrough", "historySealedAt", "cleanupAfter"].every((field) => {
              const value = (row as unknown as Record<string, unknown>)[field];
              return value === null || (typeof value === "number" && Number.isSafeInteger(value));
            }) ||
            ![null, "archive", "delete"].includes(row.disposal)
          )
            return err(failure());
        }
        for (const orb of projected.value.orbs)
          if (
            typeof orb.id !== "string" ||
            !Number.isSafeInteger(orb.stateVersion) ||
            orb.stateVersion < 0 ||
            !Number.isSafeInteger(orb.hostIncarnation) ||
            !orb.messages.every(
              (message) => typeof message.id === "string" && typeof message.wake === "boolean",
            )
          )
            return err(failure());
        for (const candidate of projected.value.resumeCandidates)
          if (typeof candidate.orbId !== "string" || !Number.isSafeInteger(candidate.stateVersion))
            return err(failure());
        return ok(projected.value);
      }),
  };
}

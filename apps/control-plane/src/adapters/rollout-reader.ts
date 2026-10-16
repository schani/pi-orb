import { err, ok, type Result, ResultAsync } from "neverthrow";
import type { Rollout, RolloutReadError, RolloutReader } from "../domain/rollout-sockets.ts";
import type { GcsTokenProvider } from "./hosting/gcs.ts";

const unavailable = (): RolloutReadError => ({ type: "rollout_read_unavailable" });
const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const revisions = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(identifier);

export function createRolloutReader(
  bucket: string,
  project: string,
  auth: GcsTokenProvider,
  request: typeof fetch = fetch,
): RolloutReader {
  return {
    async read(task, stop) {
      await task.checkpoint("read existing release rollout");
      const deadline = task.createDeadline(10_000, "read existing release rollout");
      const controller = new AbortController();
      const signal = controller.signal;
      const abortRead = (): void => controller.abort();
      stop.addEventListener("abort", abortRead, { once: true });
      deadline.signal.addEventListener("abort", abortRead, { once: true });
      if (stop.aborted || deadline.signal.aborted) abortRead();
      const read = ResultAsync.fromThrowable(
        async (): Promise<Result<Rollout | null, RolloutReadError>> => {
          const token = await new Promise<Result<string | null, RolloutReadError>>((resolve) => {
            let settled = false;
            const finish = (result: Result<string | null, RolloutReadError>): void => {
              if (settled) return;
              settled = true;
              signal.removeEventListener("abort", abort);
              resolve(result);
            };
            const abort = (): void => finish(err(unavailable()));
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
            else
              void ResultAsync.fromThrowable(() => auth.getAccessToken(), unavailable)().then(
                finish,
              );
          });
          if (token.isErr() || token.value === null) return err(unavailable());
          const missing = Symbol("missing object");
          const get = async (name: string): Promise<unknown> => {
            const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent("static-plane/releases/" + name + ".json")}?alt=media`;
            const response = await request(url, {
              headers: { authorization: `Bearer ${token.value}` },
              signal,
              redirect: "error",
            });
            if (response.status === 404) return missing;
            if (!response.ok) return undefined;
            return response.json();
          };
          const pointer = await get("latest");
          if (pointer === missing) return ok(null);
          if (
            !object(pointer) ||
            !identifier(pointer.releaseId) ||
            ["active", "latest"].includes(pointer.releaseId)
          )
            return err(unavailable());
          const record = await get(pointer.releaseId);
          if (record === missing) return ok(null);
          if (
            !object(record) ||
            record.releaseId !== pointer.releaseId ||
            record.project !== project ||
            typeof record.phase !== "string"
          )
            return err(unavailable());
          if (record.schemaVersion !== 1) return err(unavailable());
          if (record.phase !== "retire") return ok(null);
          if (
            record.exitCode !== null ||
            record.finishedAt !== null ||
            record.applyAttempted !== true ||
            record.outcome !== "applied-but-unvalidated" ||
            !object(record.gates) ||
            record.gates.repair !== "passed" ||
            record.gates.retire !== "running"
          )
            return ok(null);
          if (
            !object(record.artifacts) ||
            !Number.isSafeInteger(record.artifacts.deploy_generation) ||
            (record.artifacts.deploy_generation as number) <= 0 ||
            !object(record.retirement) ||
            !revisions(record.retirement.resources) ||
            !revisions(record.retirement.revisions) ||
            !Array.isArray(record.serving) ||
            record.serving.length !== 1
          )
            return err(unavailable());
          const serving: unknown = record.serving[0];
          if (
            !object(serving) ||
            serving.service !== "pi-orb-issuer" ||
            !identifier(serving.revision) ||
            serving.generation !== record.artifacts.deploy_generation
          )
            return err(unavailable());
          return ok({
            releaseId: pointer.releaseId,
            phase: record.phase,
            generation: record.artifacts.deploy_generation as number,
            resources: [...record.retirement.resources, ...record.retirement.revisions],
            servingRevision: serving.revision,
          });
        },
        unavailable,
      );
      const result = await read();
      deadline.cancel();
      stop.removeEventListener("abort", abortRead);
      deadline.signal.removeEventListener("abort", abortRead);
      return result.andThen((value) => value);
    },
  };
}

import { Readable } from "node:stream";
import { type UploadProgress, UploadProgressSchema } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import { Check } from "typebox/value";
import type { ControlPlaneDeps } from "../domain/ports.ts";
import type { UploadRow } from "../domain/workspace-uploads.ts";

type Failure = { type: "upload_transport"; message: string };
const failure = (message: string): Failure => ({ type: "upload_transport", message });
/** Node fetch consumes the incoming stream with backpressure; only metadata responses are parsed. */
export function uploadRequest(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  row: UploadRow,
  action: "status" | "chunk" | "finish" | "cancel",
  options: { source?: Readable; length?: number; offset?: number; signal?: AbortSignal } = {},
) {
  const run = async (): Promise<Result<UploadProgress, Failure>> => {
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(120_000)])
      : AbortSignal.timeout(120_000);
    const orb = await deps.store.getOrb(task, row.orbId);
    if (
      orb.isErr() ||
      !orb.value ||
      orb.value.state !== "running" ||
      orb.value.hostRef === null ||
      orb.value.hostIncarnation !== row.incarnation ||
      orb.value.hostDiscardThroughIncarnation !== null
    )
      return err(failure("orb is no longer running on this incarnation"));
    const host = await deps.hostProvider.observe(
      task,
      { provider: deps.hostProvider.kind, resourceId: orb.value.hostRef },
      { signal },
    );
    if (host.isErr() || !host.value?.runtimeAddress) return err(failure("runtime unavailable"));
    const query = new URLSearchParams({
      name: row.name,
      size: String(row.size),
      offset: String(options.offset ?? 0),
    });
    const headers: Record<string, string> = { "x-orb-incarnation": String(row.incarnation) };
    if (options.source) {
      headers["content-type"] = "application/octet-stream";
      headers["content-length"] = String(options.length);
    }
    const response = await ResultAsync.fromPromise(
      fetch(`${host.value.runtimeAddress.baseUrl}/v1/uploads/${row.id}/${action}?${query}`, {
        method:
          action === "status"
            ? "GET"
            : action === "chunk"
              ? "PUT"
              : action === "cancel"
                ? "DELETE"
                : "POST",
        headers,
        signal,
        ...(options.source
          ? {
              body: Readable.toWeb(options.source, {
                strategy: {
                  highWaterMark: 64 * 1024,
                  size: (chunk: Uint8Array) => chunk.byteLength,
                },
              }) as NonNullable<NonNullable<Parameters<typeof fetch>[1]>["body"]>,
              duplex: "half",
            }
          : {}),
      }),
      () => failure("upload connection interrupted; retry to reconcile its offset"),
    );
    if (response.isErr()) return err(response.error);
    if (!response.value.ok) {
      await ResultAsync.fromPromise(response.value.body?.cancel() ?? Promise.resolve(), () =>
        failure("response close failed"),
      );
      return err(failure(`runtime rejected upload (${response.value.status})`));
    }
    const body = await ResultAsync.fromPromise(response.value.json(), () =>
      failure("invalid upload response"),
    );
    if (body.isErr()) return err(body.error);
    return Check(UploadProgressSchema, body.value)
      ? ok(body.value)
      : err(failure("invalid upload progress"));
  };
  return ResultAsync.fromPromise(run(), () => failure("upload transport failed")).andThen(
    (result) => result,
  );
}

import { Readable } from "node:stream";
import {
  UPLOAD_CHUNK_BYTES,
  UploadBatchSchema,
  type UploadSpec,
  type WorkspaceUpload,
} from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import type { FastifyInstance, FastifyReply } from "fastify";
import { Check } from "typebox/value";
import { uploadRequest } from "../adapters/workspace-upload-http.ts";
import type { ControlPlaneDeps } from "../domain/ports.ts";
import { notifyUpload, type UploadRow } from "../domain/workspace-uploads.ts";

const view = (r: UploadRow): WorkspaceUpload => ({
  id: r.id,
  batchId: r.batchId,
  name: r.name,
  size: r.size,
  offset: r.offset,
  path: r.path,
  sha256: r.sha256,
  status: r.status,
  error: r.error,
});
const fail = (reply: FastifyReply, status: number, message: string) =>
  reply.code(status).send({
    error: {
      code: status === 404 ? "not_found" : status === 409 ? "conflict" : "unavailable",
      message,
      retryable: status >= 500,
    },
  });
export function registerWorkspaceUploadRoutes(
  app: FastifyInstance,
  task: SimulationTask,
  deps: ControlPlaneDeps,
) {
  void app.register(async (scope) => {
    scope.addContentTypeParser("application/octet-stream", (_request, payload, done) =>
      done(null, payload),
    );
    scope.get<{ Params: { orbId: string } }>(
      "/api/v1/orbs/:orbId/uploads",
      async (request, reply) => {
        const orb = await deps.store.getOrb(task, request.params.orbId);
        if (orb.isErr()) return fail(reply, 503, "cannot load orb");
        if (!orb.value) return fail(reply, 404, "Orb doesn't exist");
        const rows = await deps.store.uploads.list(task, request.params.orbId);
        return rows.isErr()
          ? fail(reply, 503, "cannot load uploads")
          : reply.send(rows.value.map(view));
      },
    );
    scope.post<{ Params: { orbId: string } }>(
      "/api/v1/orbs/:orbId/uploads",
      { bodyLimit: 1024 * 1024 },
      async (request, reply) => {
        if (
          !Check(UploadBatchSchema, request.body) ||
          request.body.files.some((file) => [".", ".."].includes(file.name))
        )
          return fail(reply, 400, "invalid upload metadata");
        const row = await deps.store.uploads.createBatch(
          task,
          request.params.orbId,
          request.body,
          task.wallNow(),
        );
        return row.isErr()
          ? fail(reply, 409, "upload requires a running orb and matching file metadata")
          : reply.send(row.value.map(view));
      },
    );
    scope.route<{
      Params: { orbId: string; id: string; action: string };
      Querystring: { offset?: string };
    }>({
      method: ["GET", "PUT", "POST", "DELETE"],
      url: "/api/v1/orbs/:orbId/uploads/:id/:action",
      bodyLimit: UPLOAD_CHUNK_BYTES,
      handler: async (request, reply) => {
        const rows = await deps.store.uploads.list(task, request.params.orbId);
        if (rows.isErr()) return fail(reply, 503, "cannot load upload");
        const old = rows.value.find((r) => r.id === request.params.id);
        if (!old) return fail(reply, 404, "Upload doesn't exist");
        const action = request.params.action;
        if (!(["status", "chunk", "finish", "cancel"] as string[]).includes(action))
          return fail(reply, 404, "Upload action doesn't exist");
        const method = { status: "GET", chunk: "PUT", finish: "POST", cancel: "DELETE" }[action];
        if (request.method !== method) return fail(reply, 400, "invalid upload method");
        if (old.status === "notified" || old.status === "cancelled") return reply.send(view(old));
        if (old.status === "stored") {
          const notified = await notifyUpload(task, deps.store, old);
          return reply.send(view(notified.isOk() ? notified.value : old));
        }
        const spec: UploadSpec = { id: old.id, name: old.name, size: old.size };
        const admitted = await deps.store.uploads.admit(task, old.orbId, spec, task.wallNow());
        if (admitted.isErr())
          return fail(reply, 409, "orb is not running; start it before resuming upload");
        let row = admitted.value;
        if (action === "finish") {
          if (row.offset !== row.size)
            return fail(reply, 409, "upload is incomplete; reconcile its offset before finalizing");
          const pending = await deps.store.uploads.record(
            task,
            row,
            { status: "finalizing", error: null },
            task.wallNow(),
          );
          if (pending.isErr()) return fail(reply, 409, "upload changed during finalization");
          row = pending.value;
        }
        const length = Number(request.headers["content-length"]);
        const offset = Number(request.query.offset);
        if (
          action === "chunk" &&
          (!(request.body instanceof Readable) ||
            !Number.isSafeInteger(length) ||
            length <= 0 ||
            length > UPLOAD_CHUNK_BYTES ||
            !Number.isSafeInteger(offset) ||
            offset < 0)
        )
          return fail(reply, 400, "invalid chunk offset or length");
        const controller = new AbortController();
        const abort = () => controller.abort();
        request.raw.once("aborted", abort);
        const result = await uploadRequest(
          task,
          deps,
          row,
          action as "status" | "chunk" | "finish" | "cancel",
          {
            signal: controller.signal,
            ...(action === "chunk" ? { source: request.body as Readable, length, offset } : {}),
          },
        );
        request.raw.off("aborted", abort);
        if (result.isErr()) {
          await deps.store.uploads.record(
            task,
            row,
            { error: result.error.message },
            task.wallNow(),
          );
          return fail(reply, 503, result.error.message);
        }
        const stored = await deps.store.uploads.record(
          task,
          row,
          {
            ...result.value,
            status:
              action === "cancel"
                ? "cancelled"
                : result.value.path !== null
                  ? "stored"
                  : row.status,
            error: null,
          },
          task.wallNow(),
        );
        if (stored.isErr()) return fail(reply, 409, "upload outcome pending; reload to reconcile");
        const notified = await notifyUpload(task, deps.store, stored.value);
        return reply.send(view(notified.isOk() ? notified.value : stored.value));
      },
    });
  });
}

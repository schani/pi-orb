import { createHash } from "node:crypto";
import type { PreviewError } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import type { FastifyInstance, FastifyReply } from "fastify";
import { err, Result } from "neverthrow";
import { previewError } from "../domain/preview.ts";
import {
  authenticatePreviewRegistration,
  exposePreview,
  listRegisteredPreviews,
  type PreviewRegistrationDeps,
  unexposePreview,
} from "../domain/preview-registration.ts";

function sendFailure(reply: FastifyReply, error: PreviewError) {
  const status =
    error.code === "unauthenticated"
      ? 401
      : error.code === "preview_disabled" ||
          error.code === "store_unavailable" ||
          error.code === "upstream_failed"
        ? 503
        : 400;
  return reply.status(status).send({ error });
}
export function registerRuntimePreviewRoutes(
  app: FastifyInstance,
  task: SimulationTask,
  deps: PreviewRegistrationDeps,
): void {
  const authenticate = async (authorization: unknown) => {
    if (
      typeof authorization !== "string" ||
      !authorization.startsWith("Bearer ") ||
      authorization.length <= 7
    )
      return err(previewError("unauthenticated", "Runtime identity rejected"));
    const runtimeTokenHash = Result.fromThrowable(
      () => createHash("sha256").update(authorization.slice(7)).digest("hex"),
      () => previewError("upstream_failed", "Runtime authentication unavailable"),
    )();
    if (runtimeTokenHash.isErr()) return err(runtimeTokenHash.error);
    return authenticatePreviewRegistration(task, deps, runtimeTokenHash.value);
  };
  app.get("/runtime/previews", async (request, reply) => {
    const auth = await authenticate(request.headers.authorization);
    if (auth.isErr()) return sendFailure(reply, auth.error);
    const result = await listRegisteredPreviews(task, deps, auth.value);
    return result.isErr()
      ? sendFailure(reply, result.error)
      : reply.send({ previews: result.value });
  });
  app.put<{ Params: { port: string } }>("/runtime/previews/:port", async (request, reply) => {
    const auth = await authenticate(request.headers.authorization);
    if (auth.isErr()) return sendFailure(reply, auth.error);
    if (!/^[1-9][0-9]{0,4}$/.test(request.params.port))
      return sendFailure(reply, previewError("invalid_request", "Invalid preview port"));
    const result = await exposePreview(task, deps, {
      ...auth.value,
      port: Number(request.params.port),
    });
    return result.isErr()
      ? sendFailure(reply, result.error)
      : reply.send({ preview: result.value });
  });
  app.delete<{ Params: { port: string } }>("/runtime/previews/:port", async (request, reply) => {
    const auth = await authenticate(request.headers.authorization);
    if (auth.isErr()) return sendFailure(reply, auth.error);
    if (!/^[1-9][0-9]{0,4}$/.test(request.params.port))
      return sendFailure(reply, previewError("invalid_request", "Invalid preview port"));
    const result = await unexposePreview(task, deps, {
      ...auth.value,
      port: Number(request.params.port),
    });
    return result.isErr() ? sendFailure(reply, result.error) : reply.status(204).send();
  });
}

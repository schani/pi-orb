import { Readable } from "node:stream";
import { UPLOAD_CHUNK_BYTES, UploadSpecSchema } from "@pi-orb/protocol";
import type { FastifyInstance } from "fastify";
import { Check } from "typebox/value";
import { UploadFilesystem } from "./filesystem.ts";

export async function registerUploadRoutes(
  app: FastifyInstance,
  options: { workDir: string; incarnation: string; ready: () => boolean },
) {
  const files = new UploadFilesystem(options.workDir);
  await app.register(async (scope) => {
    scope.addContentTypeParser("application/octet-stream", (_request, payload, done) =>
      done(null, payload),
    );
    scope.route<{
      Params: { id: string; action: string };
      Querystring: { name: string; size: string; offset?: string };
    }>({
      method: ["GET", "PUT", "POST", "DELETE"],
      url: "/v1/uploads/:id/:action",
      bodyLimit: UPLOAD_CHUNK_BYTES,
      handler: async (request, reply) => {
        const spec = {
          id: request.params.id,
          name: request.query.name,
          size: Number(request.query.size),
        };
        if (!Check(UploadSpecSchema, spec) || [".", ".."].includes(spec.name))
          return reply.code(400).send({
            error: {
              code: "invalid_request",
              message: "invalid file metadata",
              retryable: false,
            },
          });
        if (!options.ready() || request.headers["x-orb-incarnation"] !== options.incarnation)
          return reply.code(409).send({
            error: {
              code: "conflict",
              message: "runtime incarnation unavailable",
              retryable: true,
            },
          });
        const action = request.params.action;
        const length = Number(request.headers["content-length"]);
        const offset = Number(request.query.offset);
        const result =
          request.method === "GET" && action === "status"
            ? await files.status(spec)
            : request.method === "POST" && action === "finish"
              ? await files.finish(spec)
              : request.method === "DELETE" && action === "cancel"
                ? (await files.cancel(spec)).map(() => ({ offset: 0, path: null, sha256: null }))
                : request.method === "PUT" &&
                    action === "chunk" &&
                    Number.isSafeInteger(length) &&
                    Number.isSafeInteger(offset) &&
                    request.body instanceof Readable
                  ? await files.chunk(spec, offset, length, request.body)
                  : null;
        if (result === null)
          return reply.code(400).send({
            error: {
              code: "invalid_request",
              message: "invalid upload operation",
              retryable: false,
            },
          });
        if (result.isErr())
          return reply.code(result.error.type === "upload_conflict" ? 409 : 503).send({
            error: { code: "unavailable", message: result.error.message, retryable: true },
          });
        return reply.send(result.value);
      },
    });
  });
}

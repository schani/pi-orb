import { timingSafeEqual } from "node:crypto";
import { extname } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { type FileError, fileError, openLiveFile } from "./filesystem.ts";

export const FILES_PATH = "/v1/files";
function sendError(reply: FastifyReply, error: FileError) {
  return reply.code(error.status).send({ error });
}
const types: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "application/javascript",
  mjs: "application/javascript",
  cjs: "application/javascript",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  zip: "application/zip",
  wasm: "application/wasm",
};
function mime(path: string) {
  const extension = extname(path).slice(1).toLowerCase();
  const type = Object.hasOwn(types, extension) ? types[extension] : undefined;
  if (type)
    return type.startsWith("text/") || type === "application/javascript"
      ? `${type}; charset=utf-8`
      : type;
  return /^(txt|md|jsonl?|log|csv|tsv|xml|ya?ml|[jt]sx?|py|rs|sh|toml|sql|c|h|cpp|go|java|rb)$/.test(
    extension,
  )
    ? "text/plain; charset=utf-8"
    : "application/octet-stream";
}

export function registerFileRoutes(
  app: FastifyInstance,
  options: { token: string | undefined; incarnation: string | undefined; ready: () => boolean },
): void {
  const workDir = process.env.PI_ORB_WORK_DIR;
  const root = process.env.PI_ORB_CONTAINER === "0" ? (workDir ?? "") : undefined;
  const expected = Buffer.from(`Bearer ${options.token ?? ""}`);
  app.route<{ Querystring: { path?: unknown; base?: unknown } }>({
    method: ["GET", "HEAD"],
    exposeHeadRoute: false,
    url: FILES_PATH,
    handler: async (request, reply) => {
      reply
        .header("cache-control", "no-store")
        .header("x-content-type-options", "nosniff")
        .header("referrer-policy", "no-referrer");
      const received = Buffer.from(request.headers.authorization ?? "");
      if (
        !options.token ||
        expected.length !== received.length ||
        !timingSafeEqual(expected, received)
      )
        return sendError(reply, fileError(401, "invalid runtime token"));
      if (!options.incarnation || request.headers["x-orb-incarnation"] !== options.incarnation)
        return sendError(reply, fileError(409, "stale runtime incarnation"));
      if (!options.ready()) return sendError(reply, fileError(503, "runtime is not ready"));
      const opened = await openLiveFile(request.query.path, root, request.query.base, workDir);
      if (opened.isErr()) return sendError(reply, opened.error);
      const { size, stream, close } = opened.value;
      reply
        .header("content-length", String(size))
        .header("content-type", mime(request.query.path as string));
      if (request.method === "HEAD") {
        stream.destroy();
        const closed = await close();
        return closed.isErr()
          ? sendError(reply.removeHeader("content-length"), closed.error)
          : reply.send();
      }
      stream.once("close", async () => {
        const closed = await close();
        if (closed.isErr()) request.log.warn({ error: closed.error }, "file close failed");
      });
      // A short native stream must close the socket: Content-Length then rejects incomplete EOF.
      stream.once("end", () => {
        if ("bytesRead" in stream && stream.bytesRead !== size) reply.raw.destroy();
      });
      if (reply.raw.destroyed) {
        stream.destroy();
        return reply;
      }
      return reply.send(stream);
    },
  });
}

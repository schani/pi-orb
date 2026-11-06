import type { SimulationTask } from "determined";
import type { FastifyInstance, FastifyReply } from "fastify";
import { err, ok, Result, type Result as ResultType } from "neverthrow";
import {
  type FileError,
  type FileResponse,
  type OrbFilesTransport,
  readOrbFile,
  recordFileOutcome,
} from "../domain/orb-files.ts";
import type { ControlPlaneDeps } from "../domain/ports.ts";
import { requestAuthOrigin } from "./auth-routes.ts";
import { liveFileRoute } from "./orb-files-url.ts";

const escaped = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
function deny(reply: FastifyReply, error: FileError, appOrigin: string): void {
  reply.status(error.status);
  if (
    reply.request.headers["sec-fetch-mode"] === "navigate" &&
    reply.request.headers["sec-fetch-dest"] === "document"
  )
    void reply
      .type("text/html")
      .send(
        `<!doctype html><title>Orb file unavailable</title><p>${escaped(error.message)}</p><a href="${escaped(appOrigin)}">Dashboard</a>`,
      );
  else void reply.send({ error });
}
export function filePath(url: string): ResultType<string, FileError> {
  const path = url.split("?")[0] ?? "";
  const invalid = (): FileError => ({ status: 400, message: "Invalid absolute file path" });
  const parts = Result.fromThrowable(() => path.split("/").map(decodeURIComponent), invalid)();
  if (parts.isErr()) return err(parts.error);
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("#") ||
    parts.value.slice(1).some(
      // biome-ignore lint/suspicious/noControlCharactersInRegex: reject decoded separators and control characters.
      (part) => /^(?:\.{1,2})$|[/\\\u0000-\u001f\u007f]/u.test(part),
    )
  )
    return err(invalid());
  return ok(parts.value.join("/"));
}
export function registerOrbFilesBoundary(
  app: FastifyInstance,
  options: { filesOrigin: string; appOrigin: string },
): void {
  app.addHook("onRequest", async (request, reply) => {
    if (
      requestAuthOrigin(request, options) !== options.filesOrigin ||
      !liveFileRoute(request.originalUrl)
    )
      return;
    const reject = (status: FileError["status"], message: string) =>
      deny(reply, { status, message }, options.appOrigin);
    reply
      .header("cache-control", "no-store")
      .header("x-content-type-options", "nosniff")
      .header("referrer-policy", "no-referrer");
    if (
      request.headers["service-worker"] !== undefined ||
      request.headers["sec-fetch-dest"] === "serviceworker" ||
      request.headers.upgrade !== undefined
    )
      return reject(403, "Service workers and upgrades cannot read orb files");
    if (request.method !== "GET" && request.method !== "HEAD")
      return reject(405, "Orb files are read-only");
  });
}
export function registerOrbFilesGateway(
  app: FastifyInstance,
  task: SimulationTask,
  options: {
    deps: ControlPlaneDeps;
    filesOrigin: string;
    appOrigin: string;
    transport: OrbFilesTransport;
  },
): void {
  const { deps, transport, appOrigin } = options;
  for (const url of ["/files/:orbId/*", "/files/repo/:orbId/*"])
    app.route({
      method: ["GET", "HEAD"],
      url,
      logLevel: "silent",
      handler: async (request, reply) => {
        const target = liveFileRoute(request.originalUrl);
        if (requestAuthOrigin(request, options) !== options.filesOrigin || !target)
          return deny(reply, { status: 404, message: "Orb file doesn't exist" }, appOrigin);
        const principal = request.principal;
        if (principal?.kind !== "user")
          return deny(
            reply,
            { status: 401, message: "Orb file authentication required" },
            appOrigin,
          );
        const path = filePath(target.path);
        if (path.isErr()) return deny(reply, path.error, appOrigin);
        if (target.base && path.value === "/")
          return deny(
            reply,
            { status: 400, message: "A repository file path is required" },
            appOrigin,
          );
        const expiresAt = request.authExpiresAt ?? task.wallNow() + 120_000;
        const controller = new AbortController();
        const deadline = task.createDeadline(
          Math.max(0, Math.min(120_000, expiresAt - task.wallNow())),
          "file request deadline",
        );
        const abort = () => controller.abort();
        deadline.signal.addEventListener("abort", abort, { once: true });
        request.raw.once("aborted", abort);
        reply.raw.once("close", () => {
          abort();
          deadline.cancel();
          deadline.signal.removeEventListener("abort", abort);
          request.raw.off("aborted", abort);
        });
        if (deadline.signal.aborted || expiresAt <= task.wallNow()) abort();
        const cancelled: FileError = {
          status: 503,
          message: "Orb file request expired or disconnected",
        };
        let cancel = () => {};
        const cancellation = new Promise<ResultType<FileResponse, FileError>>((resolve) => {
          cancel = () => resolve(err(cancelled));
          controller.signal.addEventListener("abort", cancel, { once: true });
          if (controller.signal.aborted) cancel();
        });
        const response = await Promise.race([
          readOrbFile(
            task,
            deps,
            transport,
            {
              orbId: target.orbId,
              ownerUserId: principal.user.id,
              method: request.method as "GET" | "HEAD",
              path: target.base ? path.value.slice(1) : path.value,
              ...(target.base ? { base: target.base } : {}),
            },
            controller.signal,
          ),
          cancellation,
        ]);
        controller.signal.removeEventListener("abort", cancel);
        if (response.isErr()) {
          abort();
          recordFileOutcome(task, deps, target.orbId, response.error);
          return deny(reply, response.error, appOrigin);
        }
        const { body, contentType, length } = response.value;
        const outcome = (error: FileError | null) =>
          recordFileOutcome(task, deps, target.orbId, error);
        body?.once("error", () => {
          if (!controller.signal.aborted || deadline.signal.aborted)
            outcome({ status: 503, message: "Orb file stream interrupted" });
        });
        body?.once("end", () => outcome(null));
        if (!body) outcome(null);
        reply.header("content-type", contentType).header("content-length", length);
        return reply.send(body ?? "");
      },
    });
}

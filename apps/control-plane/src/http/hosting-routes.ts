import { createHash, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import {
  HOSTING_FILES_PATH,
  HOSTING_REQUEST_ID_HEADER,
  HOSTING_SHA256_HEADER,
  HOSTING_TRANSFER_TIMEOUT_MS,
  HostedPathSchema,
  HostingRequestIdSchema,
  HostingSha256Schema,
} from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { err, ok, okAsync, type Result, ResultAsync } from "neverthrow";
import { Check } from "typebox/value";
import { RUNTIME_TOKEN_STATES } from "../domain/broker.ts";
import {
  getHostedFileInventory,
  openHostedFileSnapshot,
  publishHostedFile,
  removeHostedFile,
  resolveHostedFile,
} from "../domain/hosting.ts";
import type { HostedByteSource, HostingDeps } from "../domain/hosting-ports.ts";
import type { HostingError } from "../domain/hosting-types.ts";
import type { OrbRow } from "../domain/orb.ts";
import type { ControlPlaneStore, OperationContext } from "../domain/ports.ts";

export interface HostingRouteDeps {
  readonly store: ControlPlaneStore;
  readonly hosting: HostingDeps;
  readonly filesOrigin: string;
  readonly appOrigin: string;
  readonly requestTimeoutMs?: number;
}

const failure = (reply: FastifyReply, error: HostingError) => {
  const status =
    error.type === "hosting_invalid"
      ? 400
      : error.type === "hosting_not_found"
        ? 404
        : error.type === "hosting_too_large"
          ? 413
          : error.type === "hosting_unauthorized"
            ? 401
            : error.type === "hosting_conflict"
              ? 409
              : error.type === "hosting_corruption"
                ? 500
                : 503;
  const code =
    status === 400
      ? "invalid_request"
      : status === 401
        ? "unauthorized"
        : status === 404
          ? "not_found"
          : status === 409
            ? "conflict"
            : status === 413
              ? "too_large"
              : status === 500
                ? "internal"
                : "unavailable";
  return reply.status(status).send({
    error: {
      code,
      message: error.message,
      retryable: status === 503,
    },
  });
};

const tokenHash = (authorization: unknown): string | null =>
  typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? createHash("sha256").update(authorization.slice(7)).digest("hex")
    : null;

const sameHash = (left: string, right: string): boolean => {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
};

const withContext = <T>(
  request: FastifyRequest,
  timeoutMs: number,
  run: (context: OperationContext) => PromiseLike<T>,
): Promise<T> => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.raw.once("aborted", abort);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return Promise.resolve(run({ signal: controller.signal })).finally(() => {
    clearTimeout(timeout);
    request.raw.off("aborted", abort);
  });
};

function requestSource(stream: Readable): HostedByteSource {
  const iterator = stream[Symbol.asyncIterator]();
  return {
    next: (_task, context) =>
      ResultAsync.fromPromise(
        new Promise<Uint8Array | null>((resolve, reject) => {
          if (context.signal.aborted) return reject(new Error("cancelled"));
          const abort = () => reject(new Error("cancelled"));
          context.signal.addEventListener("abort", abort, { once: true });
          void iterator.next().then((item) => {
            context.signal.removeEventListener("abort", abort);
            resolve(item.done ? null : new Uint8Array(item.value));
          }, reject);
        }),
        () => ({ type: "hosting_cancelled", message: "upload stream interrupted" }) as const,
      ),
    close: () => {
      stream.resume();
      return okAsync(undefined);
    },
  };
}

type Auth = { type: "orb"; orb: OrbRow } | { type: "unauthorized" } | { type: "unavailable" };
async function authenticate(
  task: SimulationTask,
  deps: HostingRouteDeps,
  request: FastifyRequest,
): Promise<Auth> {
  const hash = tokenHash(request.headers.authorization);
  if (hash === null) return { type: "unauthorized" };
  const found = await deps.store.getOrbByRuntimeTokenHash(task, hash);
  if (found.isErr()) return { type: "unavailable" };
  if (found.value === null) return { type: "unauthorized" };
  const orb = found.value;
  return orb.runtimeTokenHash !== null &&
    orb.hostDiscardThroughIncarnation === null &&
    sameHash(orb.runtimeTokenHash, hash) &&
    RUNTIME_TOKEN_STATES.includes(orb.state)
    ? { type: "orb", orb }
    : { type: "unauthorized" };
}

const view = (
  filesOrigin: string,
  file: { path: string; orbId: string; size: number; mediaType: string; updatedAt: number },
) => ({
  path: file.path,
  url: `${filesOrigin}/s/${file.orbId}/${file.path.split("/").map(encodeURIComponent).join("/")}`,
  size: file.size,
  mediaType: file.mediaType,
  updatedAt: file.updatedAt,
});

const isOrbId = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);

const authFailure = (reply: FastifyReply, auth: Exclude<Auth, { type: "orb" }>) =>
  reply.status(auth.type === "unavailable" ? 503 : 401).send({
    error: {
      code: auth.type === "unavailable" ? "unavailable" : "unauthorized",
      message: auth.type === "unavailable" ? "hosting unavailable" : "runtime identity rejected",
      retryable: auth.type === "unavailable",
    },
  });

export async function registerRuntimeHostingRoutes(
  app: FastifyInstance,
  task: SimulationTask,
  deps: HostingRouteDeps,
): Promise<void> {
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", (_request, payload, done) => done(null, payload));
    scope.post(HOSTING_FILES_PATH, async (request, reply) => {
      const auth = await authenticate(task, deps, request);
      if (auth.type !== "orb") return authFailure(reply, auth);
      const query = request.query as { path?: string };
      const size = Number(request.headers["content-length"]);
      const requestId = request.headers[HOSTING_REQUEST_ID_HEADER];
      const sha256 = request.headers[HOSTING_SHA256_HEADER];
      if (
        Object.keys(query).length !== 1 ||
        !Check(HostedPathSchema, query.path) ||
        !Check(HostingRequestIdSchema, requestId) ||
        !Check(HostingSha256Schema, sha256) ||
        !Number.isSafeInteger(size) ||
        size < 0
      )
        return reply.status(400).send({
          error: { code: "invalid_request", message: "invalid upload metadata", retryable: false },
        });
      const result = await withContext(
        request,
        deps.requestTimeoutMs ?? HOSTING_TRANSFER_TIMEOUT_MS,
        (context) =>
          publishHostedFile(
            task,
            deps.hosting,
            {
              orbId: auth.orb.id,
              runtimeTokenHash: auth.orb.runtimeTokenHash as string,
              incarnation: auth.orb.hostIncarnation,
              requestId,
              path: query.path as string,
              size,
              mediaType: String(request.headers["content-type"] ?? "application/octet-stream"),
              sha256,
            },
            requestSource(request.body as Readable),
            context,
          ),
      );
      return result.isErr()
        ? failure(reply, result.error)
        : reply.status(201).send({ file: view(deps.filesOrigin, result.value) });
    });
  });
  app.get(HOSTING_FILES_PATH, async (request, reply) => {
    const auth = await authenticate(task, deps, request);
    if (auth.type !== "orb") return authFailure(reply, auth);
    const files = await getHostedFileInventory(task, deps.hosting, auth.orb.id);
    return files.isErr()
      ? failure(reply, files.error)
      : reply.send({
          files: files.value.files.map((file) => view(deps.filesOrigin, file)),
          cleanupIssues: files.value.cleanupIssues,
        });
  });
  app.delete(HOSTING_FILES_PATH, async (request, reply) => {
    const auth = await authenticate(task, deps, request);
    if (auth.type !== "orb") return authFailure(reply, auth);
    const path = (request.query as { path?: string }).path;
    if (typeof path !== "string")
      return reply.status(400).send({
        error: { code: "invalid_request", message: "path is required", retryable: false },
      });
    const removed = await removeHostedFile(
      task,
      deps.hosting,
      {
        orbId: auth.orb.id,
        runtimeTokenHash: auth.orb.runtimeTokenHash as string,
        incarnation: auth.orb.hostIncarnation,
      },
      path,
    );
    return removed.isErr() ? failure(reply, removed.error) : reply.send({ path });
  });
}

export function registerBrowserHostingRoutes(
  app: FastifyInstance,
  task: SimulationTask,
  deps: HostingRouteDeps,
): void {
  app.get<{ Params: { orbId: string } }>(
    "/api/v1/orbs/:orbId/hosted-files",
    async (request, reply) => {
      if (!isOrbId(request.params.orbId))
        return reply.status(404).send({
          error: { code: "not_found", message: "orb does not exist", retryable: false },
        });
      const orb = await deps.store.getOrb(task, request.params.orbId);
      if (orb.isErr())
        return reply.status(503).send({
          error: { code: "unavailable", message: "hosting unavailable", retryable: true },
        });
      if (orb.value === null)
        return reply
          .status(404)
          .send({ error: { code: "not_found", message: "orb does not exist", retryable: false } });
      const inventory = await getHostedFileInventory(task, deps.hosting, request.params.orbId);
      return inventory.isErr()
        ? failure(reply, inventory.error)
        : reply.send({
            files: inventory.value.files.map((file) => view(deps.filesOrigin, file)),
            cleanupIssues: inventory.value.cleanupIssues,
          });
    },
  );
  app.route<{ Params: { orbId: string; "*": string } }>({
    method: ["GET", "HEAD"],
    url: "/s/:orbId/*",
    handler: async (request, reply) => {
      if (!isOrbId(request.params.orbId))
        return reply
          .status(404)
          .type("text/html")
          .send(`<p>Hosted file doesn't exist.</p><a href="${deps.appOrigin}">Dashboard</a>`);
      const path =
        request.params["*"] === "" || request.params["*"].endsWith("/")
          ? `${request.params["*"]}index.html`
          : request.params["*"];
      let resolved = await resolveHostedFile(task, deps.hosting, request.params.orbId, path);
      if (resolved.isErr()) return failure(reply, resolved.error);
      if (
        resolved.value === null &&
        request.params["*"] !== "" &&
        !request.params["*"].endsWith("/")
      ) {
        const index = await resolveHostedFile(
          task,
          deps.hosting,
          request.params.orbId,
          `${path}/index.html`,
        );
        if (index.isErr()) return failure(reply, index.error);
        if (index.value !== null) {
          const [pathname, query = ""] = request.url.split("?", 2);
          return reply.redirect(`${pathname}/${query === "" ? "" : `?${query}`}`, 308);
        }
        resolved = index;
      }
      if (resolved.value === null)
        return reply
          .status(404)
          .type("text/html")
          .send(`<p>Hosted file doesn't exist.</p><a href="${deps.appOrigin}">Dashboard</a>`);
      const file = resolved.value;
      const etag = `"${file.sha256}"`;
      const successHeaders = () =>
        reply
          .header("cache-control", "private, no-cache")
          .header("content-length", file.size)
          .header("etag", etag)
          .header("x-content-type-options", "nosniff")
          .type(file.mediaType);
      if (request.headers["if-none-match"] === etag) return successHeaders().status(304).send();
      if (request.method === "HEAD") return successHeaders().send();
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        deps.requestTimeoutMs ?? HOSTING_TRANSFER_TIMEOUT_MS,
      );
      request.raw.once("aborted", () => controller.abort());
      const opened = await openHostedFileSnapshot(task, deps.hosting, file, {
        signal: controller.signal,
      });
      if (opened.isErr()) {
        clearTimeout(timeout);
        return failure(reply, opened.error);
      }
      const prepared = await prepareSourceStream(opened.value.source, task, controller);
      if (prepared.isErr()) {
        clearTimeout(timeout);
        return failure(reply, prepared.error);
      }
      successHeaders();
      const stream = prepared.value;
      stream.once("close", () => clearTimeout(timeout));
      return reply.send(stream);
    },
  });
}

async function prepareSourceStream(
  source: HostedByteSource,
  task: SimulationTask,
  controller: AbortController,
): Promise<Result<Readable, HostingError>> {
  const first = await source.next(task, { signal: controller.signal });
  if (first.isErr()) {
    await source.close(task);
    return err(first.error);
  }
  if (first.value === null) {
    const closed = await source.close(task);
    return closed.isErr() ? err(closed.error) : ok(Readable.from([]));
  }
  const second = await source.next(task, { signal: controller.signal });
  if (second.isErr()) {
    await source.close(task);
    return err(second.error);
  }
  let pulling = false;
  let closed = false;
  let held: Uint8Array | null = first.value;
  let lookahead: Uint8Array | null | undefined = second.value;
  const close = async () => {
    if (closed) return;
    closed = true;
    controller.abort();
    await source.close(task);
  };
  const stream = new Readable({
    read() {
      if (pulling || closed) return;
      pulling = true;
      void (async () => {
        if (lookahead !== undefined) {
          const ready = held;
          held = lookahead;
          lookahead = undefined;
          pulling = false;
          stream.push(ready);
          if (held === null) {
            await close();
            stream.push(null);
          }
          return;
        }
        const next = await source.next(task, { signal: controller.signal });
        pulling = false;
        if (next.isErr()) {
          await close();
          stream.destroy(new Error(next.error.message));
          return;
        }
        const ready = held;
        held = next.value;
        stream.push(ready);
        if (next.value === null) {
          await close();
          stream.push(null);
        }
      })();
    },
    destroy(error, callback) {
      void close().then(() => callback(error));
    },
  });
  return ok(stream);
}

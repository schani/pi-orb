import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { finished } from "node:stream/promises";
import {
  HOSTING_FILES_PATH,
  HOSTING_REQUEST_ID_HEADER,
  HOSTING_SHA256_HEADER,
  HOSTING_TRANSFER_TIMEOUT_MS,
  HostedFileDeleteResponseSchema,
  type HostedFileResponse,
  HostedFileResponseSchema,
  type HostedFilesResponse,
  HostedFilesResponseSchema,
  HostedPathSchema,
  type HostingErrorBody,
  HostingErrorSchema,
} from "@pi-orb/protocol";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import type { BrokerEnv } from "../broker/endpoint.ts";

export const HOSTING_USAGE =
  "usage: pi-orb host <file> [path] [--request-id <uuid>]\n       pi-orb host ls\n       pi-orb host rm <path>";
export type HostingAction =
  | { readonly type: "list" }
  | { readonly type: "remove"; readonly path: string }
  | {
      readonly type: "publish";
      readonly file: string;
      readonly path: string;
      readonly requestId: string;
    };
export type HostingFailure = {
  readonly type: "hosting_failure";
  readonly code: string;
  readonly message: string;
};
const failure = (code: string, message: string): HostingFailure => ({
  type: "hosting_failure",
  code,
  message,
});

export function parseHostingArgs(args: readonly string[]): Result<HostingAction, HostingFailure> {
  if (args.length === 1 && args[0] === "ls") return ok({ type: "list" });
  if (args.length === 2 && args[0] === "rm" && args[1] !== undefined && args[1] !== "")
    return ok({ type: "remove", path: args[1] });
  const requestFlag = args.indexOf("--request-id");
  const requestId = requestFlag === -1 ? randomUUID() : args[requestFlag + 1];
  const operands =
    requestFlag === -1
      ? [...args]
      : args.filter((_value, index) => index !== requestFlag && index !== requestFlag + 1);
  if (
    operands.length < 1 ||
    operands.length > 2 ||
    requestId === undefined ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId) ||
    !Check(HostedPathSchema, operands[1] ?? basename(operands[0] ?? ""))
  )
    return err(failure("invalid_request", HOSTING_USAGE));
  const file = operands[0];
  if (file === undefined) return err(failure("invalid_request", HOSTING_USAGE));
  return ok({
    file,
    path: operands[1] ?? basename(file),
    requestId,
    type: "publish",
  });
}

function hostingRequest<T>(
  env: BrokerEnv,
  url: URL,
  method: "GET" | "DELETE",
  schema: TSchema,
  request: typeof fetch,
): ResultAsync<T, HostingFailure> {
  return ResultAsync.fromPromise(
    (async () => {
      const response = await request(url, {
        headers: { authorization: `Bearer ${env.runtimeToken}` },
        method,
        signal: AbortSignal.timeout(10_000),
      });
      return { body: await boundedJson(response), ok: response.ok };
    })(),
    () => failure("unavailable", "hosting service is unavailable"),
  ).andThen(({ body, ok: succeeded }) => {
    if (succeeded && Check(schema, body)) return ok(body as T);
    if (Check(HostingErrorSchema, body)) {
      const error = (body as HostingErrorBody).error;
      return err(failure(error.code, error.message));
    }
    return err(failure("unavailable", "hosting service returned an invalid response"));
  });
}

export function listHostedFiles(
  env: BrokerEnv,
  request: typeof fetch = fetch,
): ResultAsync<HostedFilesResponse, HostingFailure> {
  return hostingRequest(
    env,
    new URL(HOSTING_FILES_PATH, env.controlPlaneUrl),
    "GET",
    HostedFilesResponseSchema,
    request,
  );
}

export function removeHostedFile(
  env: BrokerEnv,
  path: string,
  request: typeof fetch = fetch,
): ResultAsync<{ path: string }, HostingFailure> {
  const url = new URL(HOSTING_FILES_PATH, env.controlPlaneUrl);
  url.searchParams.set("path", path);
  return hostingRequest(env, url, "DELETE", HostedFileDeleteResponseSchema, request);
}

export function inferMediaType(path: string): string {
  return (
    (
      {
        ".css": "text/css; charset=utf-8",
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".json": "application/json",
        ".md": "text/markdown; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".pdf": "application/pdf",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".txt": "text/plain; charset=utf-8",
        ".wasm": "application/wasm",
      } as Record<string, string>
    )[extname(path).toLowerCase()] ?? "application/octet-stream"
  );
}

function fileDigest(
  path: string,
  signal: AbortSignal,
): ResultAsync<{ sha256: string; size: number }, HostingFailure> {
  return ResultAsync.fromPromise(stat(path), () =>
    failure("invalid_request", `cannot read ${path}`),
  ).andThen((metadata) => {
    if (!metadata.isFile()) return err(failure("invalid_request", `${path} is not a regular file`));
    return ResultAsync.fromPromise(
      (async () => {
        const hash = createHash("sha256");
        const stream = createReadStream(path);
        try {
          for await (const chunk of stream) {
            if (signal.aborted)
              return err(failure("unavailable", "hosting upload deadline exceeded"));
            hash.update(chunk as Buffer);
          }
        } finally {
          stream.destroy();
        }
        return ok({ sha256: hash.digest("hex"), size: metadata.size });
      })(),
      () => failure("invalid_request", `cannot read ${path}`),
    ).andThen((result) => result);
  });
}

async function boundedJson(response: Response): Promise<unknown> {
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > 64 * 1024) {
      await reader.cancel();
      return null;
    }
    chunks.push(next.value);
  }
  return JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as unknown;
}

export function uploadHostedFile(
  env: BrokerEnv,
  action: Extract<HostingAction, { type: "publish" }>,
  request: typeof fetch = fetch,
): ResultAsync<HostedFileResponse, HostingFailure> {
  const signal = AbortSignal.timeout(HOSTING_TRANSFER_TIMEOUT_MS);
  return fileDigest(action.file, signal).andThen(({ sha256, size }) =>
    ResultAsync.fromPromise(
      (async () => {
        const url = new URL(HOSTING_FILES_PATH, env.controlPlaneUrl);
        url.searchParams.set("path", action.path);
        const init = {
          body: createReadStream(action.file),
          duplex: "half",
          headers: {
            authorization: `Bearer ${env.runtimeToken}`,
            "content-length": String(size),
            "content-type": inferMediaType(action.file),
            [HOSTING_REQUEST_ID_HEADER]: action.requestId,
            [HOSTING_SHA256_HEADER]: sha256,
          },
          method: "POST",
          signal,
        } as RequestInit & { duplex: "half" };
        const stream = init.body as ReturnType<typeof createReadStream>;
        try {
          const response = await request(url, init);
          return { body: await boundedJson(response), status: response.status };
        } finally {
          stream.destroy();
          await finished(stream).catch(() => undefined);
        }
      })(),
      () =>
        failure(
          "unknown_outcome",
          `upload outcome is unknown; retry with --request-id ${action.requestId}`,
        ),
    ).andThen(({ body, status }) => {
      if (status === 201 && Check(HostedFileResponseSchema, body)) return ok(body);
      if (Check(HostingErrorSchema, body)) {
        const error = (body as HostingErrorBody).error;
        return err(failure(error.code, `${error.message}; request id ${action.requestId}`));
      }
      return err(
        failure(
          "unknown_outcome",
          `upload outcome is unknown; retry with --request-id ${action.requestId}`,
        ),
      );
    }),
  );
}

import { createHash } from "node:crypto";
import type { SimulationTask } from "determined";
import { GoogleAuth } from "google-auth-library";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import type { HostedByteStore } from "../../domain/hosting-ports.ts";
import type { HostingError, StoredHostedObject } from "../../domain/hosting-types.ts";
import type { OperationContext } from "../../domain/ports.ts";

interface GcsSession {
  expected: { size: number; sha256: string };
  key: string;
  uri: string;
}
interface GcsMetadata {
  generation?: string;
  metadata?: Record<string, string>;
  name?: string;
  size?: string;
}
export interface GcsTokenProvider {
  getAccessToken(): Promise<string | null>;
}
export interface GcsHostedByteStoreOptions {
  readonly allowedSessionHosts?: readonly string[];
  readonly auth: GcsTokenProvider;
  readonly bucket: string;
  readonly fetch?: typeof fetch;
}

export function createGcsTokenProvider(): GcsTokenProvider {
  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/devstorage.read_write"],
  });
  return {
    getAccessToken: async () => {
      const client = await auth.getClient();
      return (await client.getAccessToken()).token ?? null;
    },
  };
}

const retryable = (): HostingError => ({
  type: "hosting_retryable",
  message: "GCS hosted-byte request failed",
});
const providerFailure = (operation: string, status: number): HostingError => ({
  type: "hosting_retryable",
  message: `GCS ${operation} failed (HTTP ${status})`,
});
const conflict = (message: string): HostingError => ({ type: "hosting_conflict", message });
const cancelled = (message: string): HostingError => ({ type: "hosting_cancelled", message });
const corruption = (message: string): HostingError => ({ type: "hosting_corruption", message });
const flatten = <T>(promise: Promise<Result<T, HostingError>>): ResultAsync<T, HostingError> =>
  ResultAsync.fromPromise(promise, retryable).andThen((result) => result);
const validSha256 = (value: string): boolean => /^[a-f0-9]{64}$/.test(value);
const closeAfter = async <T>(
  source: Parameters<HostedByteStore["write"]>[2],
  task: Parameters<HostedByteStore["write"]>[0],
  run: () => Promise<Result<T, HostingError>>,
): Promise<Result<T, HostingError>> => {
  const executed = await ResultAsync.fromPromise(run(), retryable);
  const closed = await source.close(task);
  if (closed.isErr()) return err(closed.error);
  return executed.isErr() ? err(executed.error) : executed.value;
};

export function createGcsHostedByteStore(options: GcsHostedByteStoreOptions): HostedByteStore {
  const request = options.fetch ?? fetch;
  const allowedHosts = new Set(options.allowedSessionHosts ?? ["storage.googleapis.com"]);
  const authHeaders = async (): Promise<Headers | null> => {
    const token = await options.auth.getAccessToken();
    return token === null ? null : new Headers({ authorization: `Bearer ${token}` });
  };
  const sessionUrl = (value: string): URL | null => {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || !allowedHosts.has(parsed.hostname)) return null;
    return parsed;
  };
  const encodeSession = (session: GcsSession): string =>
    Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  const decodeSession = (value: string): Result<GcsSession, HostingError> => {
    try {
      const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as GcsSession;
      if (
        typeof parsed.key !== "string" ||
        typeof parsed.uri !== "string" ||
        !Number.isSafeInteger(parsed.expected?.size) ||
        parsed.expected.size < 0 ||
        !validSha256(parsed.expected.sha256) ||
        sessionUrl(parsed.uri) === null
      )
        return err(corruption("invalid GCS upload session"));
      return ok(parsed);
    } catch {
      return err(corruption("invalid GCS upload session"));
    }
  };
  const metadataUrl = (key: string, generation?: string, media = false): URL => {
    const url = new URL(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(options.bucket)}/o/${encodeURIComponent(key)}`,
    );
    if (generation !== undefined) url.searchParams.set("generation", generation);
    if (media) url.searchParams.set("alt", "media");
    return url;
  };
  const storedFrom = (
    session: GcsSession,
    metadata: GcsMetadata,
  ): Result<StoredHostedObject, HostingError> => {
    const size = Number(metadata.size);
    const sha256 = metadata.metadata?.piOrbSha256;
    if (
      metadata.name !== session.key ||
      metadata.generation === undefined ||
      size !== session.expected.size ||
      sha256 !== session.expected.sha256
    ) {
      return err(corruption("GCS object integrity metadata does not match the upload"));
    }
    return ok({ ref: { key: session.key, generation: metadata.generation }, sha256, size });
  };
  const lookupByKey = async (
    session: GcsSession,
    context: OperationContext,
  ): Promise<Result<StoredHostedObject | null, HostingError>> => {
    const headers = await authHeaders();
    if (headers === null) return err(retryable());
    const response = await request(metadataUrl(session.key), {
      headers,
      signal: context.signal,
    });
    if (response.status === 404) return ok(null);
    if (!response.ok) return err(retryable());
    const parsed = storedFrom(session, (await response.json()) as GcsMetadata);
    return parsed.isErr() ? parsed : ok(parsed.value);
  };
  const querySession = async (
    session: GcsSession,
    context: OperationContext,
  ): Promise<
    Result<
      | { type: "active" }
      | { type: "cancelled" }
      | { type: "committed"; object: StoredHostedObject },
      HostingError
    >
  > => {
    const uri = sessionUrl(session.uri);
    if (uri === null) return err(corruption("invalid stored GCS upload session"));
    const response = await request(uri, {
      method: "PUT",
      headers: { "content-length": "0", "content-range": `bytes */${session.expected.size}` },
      signal: context.signal,
    });
    if (response.status === 308) return ok({ type: "active" });
    if (response.ok) {
      const object = storedFrom(session, (await response.json()) as GcsMetadata);
      if (object.isErr()) return err(object.error);
      return ok({ type: "committed", object: object.value });
    }
    if (response.status === 404 || response.status === 410 || response.status === 499) {
      const object = await lookupByKey(session, context);
      if (object.isErr()) return err(object.error);
      if (object.value !== null) {
        return ok({ type: "committed", object: object.value });
      }
      return ok({ type: "cancelled" });
    }
    return err(retryable());
  };
  const cancelSession = async (session: GcsSession, context: OperationContext) => {
    const uri = sessionUrl(session.uri);
    if (uri === null) return err(corruption("invalid stored GCS upload session"));
    const response = await request(uri, {
      method: "DELETE",
      headers: { "content-length": "0" },
      signal: context.signal,
    });
    if (response.status === 499 || response.status === 404 || response.status === 410) {
      const queried = await querySession(session, context);
      if (queried.isErr()) return err(queried.error);
      if (queried.value.type === "committed") return ok(queried.value);
      if (queried.value.type === "active") return err(retryable());
      return ok({ type: "cancelled" as const });
    }
    const queried = await querySession(session, context);
    if (queried.isErr()) return err(queried.error);
    return queried.value.type === "active" ? err(retryable()) : ok(queried.value);
  };

  return {
    begin: (_task, key, expected, context) =>
      flatten(
        (async () => {
          if (context.signal.aborted) return err(cancelled("hosting operation was cancelled"));
          if (
            !Number.isSafeInteger(expected.size) ||
            expected.size < 0 ||
            !validSha256(expected.sha256)
          )
            return err(corruption("invalid hosted upload integrity contract"));
          const url = new URL(
            `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(options.bucket)}/o`,
          );
          url.searchParams.set("uploadType", "resumable");
          url.searchParams.set("name", key);
          url.searchParams.set("ifGenerationMatch", "0");
          const headers = await authHeaders();
          if (headers === null) return err(retryable());
          headers.set("content-type", "application/json");
          headers.set("x-upload-content-length", String(expected.size));
          const response = await request(url, {
            body: JSON.stringify({
              metadata: { piOrbSha256: expected.sha256, piOrbSize: String(expected.size) },
              name: key,
            }),
            headers,
            method: "POST",
            signal: context.signal,
          });
          const uri = response.headers.get("location");
          if (!response.ok) return err(providerFailure("upload initiation", response.status));
          if (uri === null) return err(retryable());
          if (sessionUrl(uri) === null)
            return err(corruption("GCS returned an invalid upload session"));
          return ok({ sessionId: encodeSession({ expected, key, uri }) });
        })(),
      ),
    write: (task, id, source, expected, context) =>
      flatten(
        closeAfter(source, task, async () => {
          let outcome: Result<StoredHostedObject, HostingError> | undefined;
          const decoded = decodeSession(id);
          if (decoded.isErr()) return err(decoded.error);
          const session = decoded.value;
          if (
            session.expected.size !== expected.size ||
            session.expected.sha256 !== expected.sha256
          )
            return err(conflict("hosting upload integrity contract changed"));
          const hash = createHash("sha256");
          let size = 0;
          let offset = 0;
          let pending = new Uint8Array();
          const uri = sessionUrl(session.uri);
          if (uri === null) return err(corruption("invalid stored GCS upload session"));
          for (;;) {
            if (context.signal.aborted) {
              outcome = err(cancelled("hosting upload was cancelled"));
              break;
            }
            const next = await source.next(task, context);
            if (next.isErr()) {
              outcome = err(next.error);
              break;
            }
            if (next.value === null) break;
            size += next.value.byteLength;
            hash.update(next.value);
            if (size > expected.size) {
              outcome = err(corruption("hosted upload exceeded its declared size"));
              break;
            }
            let cursor = 0;
            while (cursor < next.value.byteLength) {
              if (pending.byteLength === 256 * 1024) {
                const chunk = pending;
                pending = new Uint8Array();
                const response = await request(uri, {
                  body: chunk,
                  headers: {
                    "content-length": String(chunk.byteLength),
                    "content-range": `bytes ${offset}-${offset + chunk.byteLength - 1}/${expected.size}`,
                  },
                  method: "PUT",
                  signal: context.signal,
                });
                if (response.status !== 308) {
                  outcome = err(retryable());
                  break;
                }
                const acknowledged = response.headers.get("range")?.match(/^bytes=0-(\d+)$/);
                if (
                  acknowledged === undefined ||
                  acknowledged === null ||
                  Number(acknowledged[1]) !== offset + chunk.byteLength - 1
                ) {
                  outcome = err(retryable());
                  break;
                }
                offset += chunk.byteLength;
              }
              const take = Math.min(
                256 * 1024 - pending.byteLength,
                next.value.byteLength - cursor,
              );
              const joined = new Uint8Array(pending.byteLength + take);
              joined.set(pending);
              joined.set(next.value.subarray(cursor, cursor + take), pending.byteLength);
              pending = joined;
              cursor += take;
            }
            if (outcome !== undefined) break;
            if (pending.byteLength > 256 * 1024) {
              outcome = err(corruption("GCS upload chunk buffer exceeded its bound"));
              break;
            }
          }
          // The final chunk stays buffered until EOF and hash verification.
          const actualHash = hash.digest("hex");
          if (outcome === undefined && (size !== expected.size || actualHash !== expected.sha256))
            outcome = err(corruption("hosted upload integrity mismatch"));
          if (outcome?.isErr()) {
            await cancelSession(session, context);
            return outcome;
          }
          const range =
            expected.size === 0
              ? "bytes 0-*/0"
              : `bytes ${offset}-${offset + pending.byteLength - 1}/${expected.size}`;
          const response = await request(uri, {
            body: pending,
            headers: { "content-length": String(pending.byteLength), "content-range": range },
            method: "PUT",
            signal: context.signal,
          });
          if (!response.ok) return err(retryable());
          const object = storedFrom(session, (await response.json()) as GcsMetadata);
          if (object.isErr()) return object;
          outcome = ok(object.value);
          return outcome;
        }),
      ),
    query: (_task, id, context) =>
      flatten(
        (async () => {
          const session = decodeSession(id);
          return session.isErr() ? err(session.error) : querySession(session.value, context);
        })(),
      ),
    cancel: (_task, id, context) =>
      flatten(
        (async () => {
          const session = decodeSession(id);
          return session.isErr() ? err(session.error) : cancelSession(session.value, context);
        })(),
      ),
    statExact: (_task, ref, context) =>
      flatten(
        (async () => {
          const headers = await authHeaders();
          if (headers === null) return err(retryable());
          const response = await request(metadataUrl(ref.key, ref.generation), {
            headers,
            signal: context.signal,
          });
          if (response.status === 404) return ok(null);
          if (!response.ok) return err(retryable());
          const metadata = (await response.json()) as GcsMetadata;
          const size = Number(metadata.size);
          const sha256 = metadata.metadata?.piOrbSha256;
          return metadata.name === ref.key &&
            metadata.generation === ref.generation &&
            Number.isSafeInteger(size) &&
            sha256 !== undefined &&
            validSha256(sha256)
            ? ok({ ref, sha256, size })
            : err(corruption("invalid GCS hosted object metadata"));
        })(),
      ),
    openExact: (task, ref, context) =>
      flatten(
        (async () => {
          const stat = await createGcsHostedByteStore(options).statExact(task, ref, context);
          if (stat.isErr()) return err(stat.error);
          if (stat.value === null) return err(conflict("hosted object does not exist"));
          const object = stat.value;
          const headers = await authHeaders();
          if (headers === null) return err(retryable());
          const response = await request(metadataUrl(ref.key, ref.generation, true), {
            headers,
            signal: context.signal,
          });
          if (!response.ok || response.body === null) return err(retryable());
          const reader = response.body.getReader();
          let closed = false;
          let size = 0;
          const hash = createHash("sha256");
          return ok({
            object,
            source: {
              next: (_t: SimulationTask, c: OperationContext) =>
                c.signal.aborted
                  ? ResultAsync.fromPromise(
                      reader.cancel().then(() => null),
                      retryable,
                    ).andThen(() => err(cancelled("hosted read was cancelled")))
                  : ResultAsync.fromPromise(
                      reader.read().then((read) => {
                        if (read.done)
                          return size === object.size && hash.digest("hex") === object.sha256
                            ? ok<Uint8Array | null, HostingError>(null)
                            : err<Uint8Array | null, HostingError>(
                                corruption("GCS object failed read integrity verification"),
                              );
                        size += read.value.byteLength;
                        hash.update(read.value);
                        return ok<Uint8Array | null, HostingError>(read.value);
                      }),
                      retryable,
                    ).andThen((result) => result),
              close: () =>
                ResultAsync.fromPromise(
                  closed
                    ? Promise.resolve()
                    : reader.cancel().then(() => {
                        closed = true;
                      }),
                  retryable,
                ),
            },
          });
        })(),
      ),
    deleteExact: (_task, ref, context) =>
      flatten(
        (async () => {
          const headers = await authHeaders();
          if (headers === null) return err(retryable());
          const response = await request(metadataUrl(ref.key, ref.generation), {
            headers,
            method: "DELETE",
            signal: context.signal,
          });
          return response.ok || response.status === 404 ? ok(undefined) : err(retryable());
        })(),
      ),
  };
}

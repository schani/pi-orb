import { createHash, randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import type { HostedByteSource, HostedByteStore } from "../../domain/hosting-ports.ts";
import type {
  HostedObjectRef,
  HostingError,
  StoredHostedObject,
} from "../../domain/hosting-types.ts";

interface FileSession {
  expected: { size: number; sha256: string };
  generation: string;
  id: string;
  key: string;
}
const retryable = (cause?: unknown): HostingError => ({
  type: "hosting_retryable",
  message: `hosted file storage operation failed${
    cause !== null &&
    typeof cause === "object" &&
    "code" in cause &&
    ["EACCES", "ENOSPC", "EROFS", "EMFILE", "ENFILE"].includes(String(cause.code))
      ? ` (${String(cause.code)})`
      : ""
  }`,
});
const conflict = (message: string): HostingError => ({ type: "hosting_conflict", message });
const cancelled = (message: string): HostingError => ({ type: "hosting_cancelled", message });
const corruption = (message: string): HostingError => ({ type: "hosting_corruption", message });
const flatten = <T>(promise: Promise<Result<T, HostingError>>): ResultAsync<T, HostingError> =>
  ResultAsync.fromPromise(promise, retryable).andThen((result) => result);
const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
const remove = async (path: string): Promise<void> => {
  await unlink(path).catch((error) => (isMissing(error) ? undefined : Promise.reject(error)));
};
const closeAfter = async <T>(
  source: HostedByteSource,
  task: Parameters<HostedByteSource["close"]>[0],
  run: () => Promise<Result<T, HostingError>>,
): Promise<Result<T, HostingError>> => {
  const executed = await ResultAsync.fromPromise(run(), retryable);
  const closed = await source.close(task);
  if (closed.isErr()) return err(closed.error);
  return executed.isErr() ? err(executed.error) : executed.value;
};

export interface FilesystemHostedByteStoreOptions {
  readonly root: string;
  readonly openFile?: (path: string, flags: string, mode?: number) => Promise<FileHandle>;
  readonly renameFile?: (oldPath: string, newPath: string) => Promise<void>;
}
export function createFilesystemHostedByteStore(
  options: FilesystemHostedByteStoreOptions,
): HostedByteStore {
  const openFile = options.openFile ?? open;
  const renameFile = options.renameFile ?? rename;
  const sessions = join(options.root, "sessions");
  const objects = join(options.root, "objects");
  const keyDir = (key: string) => join(objects, createHash("sha256").update(key).digest("hex"));
  const activeDir = (s: FileSession) => join(sessions, `${s.id}.active`);
  const cancelledDir = (s: FileSession) => join(sessions, `${s.id}.cancelled`);
  const committedPath = (s: FileSession) => join(sessions, `${s.id}.committed.json`);
  const objectDir = (s: FileSession) => join(keyDir(s.key), s.generation);
  const refDir = (ref: HostedObjectRef) => join(keyDir(ref.key), ref.generation);
  const validGeneration = (value: string) => /^[0-9a-f-]{36}$/.test(value);
  const encode = (s: FileSession) => Buffer.from(JSON.stringify(s)).toString("base64url");
  const decode = (value: string): Result<FileSession, HostingError> => {
    try {
      const s = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as FileSession;
      if (
        !/^[0-9a-f-]{36}$/.test(s.id) ||
        !/^[0-9a-f-]{36}$/.test(s.generation) ||
        typeof s.key !== "string" ||
        !Number.isSafeInteger(s.expected?.size) ||
        s.expected.size < 0 ||
        !/^[a-f0-9]{64}$/.test(s.expected.sha256)
      )
        return err(corruption("invalid hosted file session"));
      return ok(s);
    } catch {
      return err(corruption("invalid hosted file session"));
    }
  };
  const readStored = async (directory: string): Promise<StoredHostedObject | null> => {
    try {
      const stored = JSON.parse(
        await readFile(join(directory, "metadata.json"), "utf8"),
      ) as StoredHostedObject;
      const handle = await openFile(join(directory, "data"), "r");
      await handle.close();
      return stored;
    } catch (error) {
      return isMissing(error) ? null : Promise.reject(error);
    }
  };
  const moveToCancelled = async (s: FileSession): Promise<boolean> => {
    try {
      await renameFile(activeDir(s), cancelledDir(s));
      return true;
    } catch (error) {
      return isMissing(error) ? false : Promise.reject(error);
    }
  };
  const persistCommitted = async (s: FileSession, stored: StoredHostedObject): Promise<void> => {
    const temporary = `${committedPath(s)}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(stored), { flag: "wx", mode: 0o600 });
    try {
      await renameFile(temporary, committedPath(s));
    } catch (error) {
      await remove(temporary);
      return Promise.reject(error);
    }
  };
  const readCommitted = async (s: FileSession): Promise<StoredHostedObject | null> => {
    const stored = await readStored(objectDir(s));
    if (stored !== null) {
      await persistCommitted(s, stored);
      return stored;
    }
    try {
      return JSON.parse(await readFile(committedPath(s), "utf8")) as StoredHostedObject;
    } catch (error) {
      return isMissing(error) ? null : Promise.reject(error);
    }
  };
  return {
    begin: (_task, key, expected, context) =>
      flatten(
        (async () => {
          if (context.signal.aborted) return err(cancelled("hosting operation was cancelled"));
          const s = { expected, generation: randomUUID(), id: randomUUID(), key };
          await mkdir(sessions, { recursive: true, mode: 0o700 });
          await mkdir(keyDir(key), { recursive: true, mode: 0o700 });
          await mkdir(activeDir(s), { mode: 0o700 });
          const data = await openFile(join(activeDir(s), "data"), "wx", 0o600);
          await data.close();
          await writeFile(join(activeDir(s), "session.json"), JSON.stringify(s), {
            flag: "wx",
            mode: 0o600,
          });
          return ok({ sessionId: encode(s) });
        })(),
      ),
    write: (task, sessionId, source, expected, context) =>
      flatten(
        closeAfter(source, task, async () => {
          const decoded = decode(sessionId);
          if (decoded.isErr()) return err(decoded.error);
          const s = decoded.value;
          if (s.expected.size !== expected.size || s.expected.sha256 !== expected.sha256)
            return err(conflict("hosting upload integrity contract changed"));
          let handle: FileHandle;
          try {
            handle = await openFile(join(activeDir(s), "data"), "r+");
          } catch (error) {
            return isMissing(error)
              ? err(cancelled("hosting upload session is not active"))
              : Promise.reject(error);
          }
          const hash = createHash("sha256");
          let size = 0;
          let failed: HostingError | null = null;
          try {
            for (;;) {
              if (context.signal.aborted) {
                failed = cancelled("hosting upload was cancelled");
                break;
              }
              const next = await source.next(task, context);
              if (next.isErr()) {
                failed = next.error;
                break;
              }
              if (next.value === null) break;
              let written = 0;
              while (written < next.value.byteLength) {
                const result = await handle.write(
                  next.value,
                  written,
                  next.value.byteLength - written,
                  null,
                );
                if (result.bytesWritten === 0) {
                  failed = retryable();
                  break;
                }
                written += result.bytesWritten;
              }
              if (failed !== null) break;
              size += next.value.byteLength;
              hash.update(next.value);
              if (size > expected.size) {
                failed = corruption("hosted upload exceeded its declared size");
                break;
              }
            }
          } finally {
            await handle.close();
          }
          const sha256 = hash.digest("hex");
          if (failed === null && (size !== expected.size || sha256 !== expected.sha256))
            failed = corruption("hosted upload integrity mismatch");
          if (failed !== null) {
            if (await moveToCancelled(s)) await remove(join(cancelledDir(s), "data"));
            return err(failed);
          }
          const stored = { ref: { key: s.key, generation: s.generation }, sha256, size };
          await writeFile(join(activeDir(s), "metadata.json"), JSON.stringify(stored), {
            flag: "wx",
            mode: 0o600,
          });
          try {
            await renameFile(activeDir(s), objectDir(s));
            await persistCommitted(s, stored);
            return ok(stored);
          } catch (error) {
            return isMissing(error)
              ? err(cancelled("hosting upload was cancelled"))
              : Promise.reject(error);
          }
        }),
      ),
    query: (_task, sessionId) =>
      flatten(
        (async () => {
          const decoded = decode(sessionId);
          if (decoded.isErr()) return err(decoded.error);
          const s = decoded.value;
          const stored = await readCommitted(s);
          if (stored !== null) {
            return ok({ type: "committed" as const, object: stored });
          }
          try {
            await readFile(join(activeDir(s), "session.json"));
            return ok({ type: "active" as const });
          } catch (error) {
            if (!isMissing(error)) return Promise.reject(error);
          }
          try {
            await readFile(join(cancelledDir(s), "session.json"));
            return ok({ type: "cancelled" as const });
          } catch (error) {
            return isMissing(error)
              ? err(conflict("unknown hosted file session"))
              : Promise.reject(error);
          }
        })(),
      ),
    cancel: (_task, sessionId) =>
      flatten(
        (async () => {
          const decoded = decode(sessionId);
          if (decoded.isErr()) return err(decoded.error);
          const s = decoded.value;
          if (await moveToCancelled(s)) {
            await remove(join(cancelledDir(s), "data"));
            return ok({ type: "cancelled" as const });
          }
          const stored = await readCommitted(s);
          if (stored !== null) {
            return ok({ type: "committed" as const, object: stored });
          }
          try {
            await readFile(join(cancelledDir(s), "session.json"));
            await remove(join(cancelledDir(s), "data"));
            return ok({ type: "cancelled" as const });
          } catch (error) {
            return isMissing(error)
              ? err(conflict("unknown hosted file session"))
              : Promise.reject(error);
          }
        })(),
      ),
    statExact: (_task, ref) =>
      validGeneration(ref.generation)
        ? ResultAsync.fromPromise(readStored(refDir(ref)), retryable)
        : flatten(Promise.resolve(err(corruption("invalid hosted object generation")))),
    openExact: (_task, ref) =>
      flatten(
        (async () => {
          if (!validGeneration(ref.generation))
            return err(corruption("invalid hosted object generation"));
          const object = await readStored(refDir(ref));
          if (object === null) return err(conflict("hosted object does not exist"));
          const handle = await openFile(join(refDir(ref), "data"), "r");
          let position = 0;
          let size = 0;
          const hash = createHash("sha256");
          let closed = false;
          return ok({
            object,
            source: {
              next: (_readTask, context) =>
                flatten(
                  (async () => {
                    if (context.signal.aborted) return err(cancelled("hosted read was cancelled"));
                    const chunk = new Uint8Array(64 * 1024);
                    const read = await handle.read(chunk, 0, chunk.byteLength, position);
                    if (read.bytesRead === 0)
                      return size === object.size && hash.digest("hex") === object.sha256
                        ? ok(null)
                        : err(corruption("hosted object failed read integrity verification"));
                    position += read.bytesRead;
                    size += read.bytesRead;
                    hash.update(chunk.subarray(0, read.bytesRead));
                    return ok(chunk.subarray(0, read.bytesRead));
                  })(),
                ),
              close: () =>
                ResultAsync.fromPromise(
                  closed
                    ? Promise.resolve()
                    : handle.close().then(() => {
                        closed = true;
                      }),
                  retryable,
                ),
            },
          });
        })(),
      ),
    deleteExact: (_task, ref) =>
      validGeneration(ref.generation)
        ? ResultAsync.fromPromise(
            Promise.all([
              remove(join(refDir(ref), "data")),
              remove(join(refDir(ref), "metadata.json")),
            ]).then(() => undefined),
            retryable,
          )
        : flatten(Promise.resolve(err(corruption("invalid hosted object generation")))),
  };
}

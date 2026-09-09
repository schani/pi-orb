import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import {
  UPLOAD_CHUNK_BYTES,
  type UploadProgress,
  UploadProgressSchema,
  type UploadSpec,
} from "@pi-orb/protocol";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import { Check } from "typebox/value";

export type UploadFileError =
  | { type: "upload_io"; message: string }
  | { type: "upload_conflict"; message: string };
const failure = (): UploadFileError => ({
  type: "upload_io",
  message: "upload filesystem operation failed",
});
const conflict = (message: string): UploadFileError => ({ type: "upload_conflict", message });
const io = <T>(fn: () => Promise<T>) => ResultAsync.fromPromise(fn(), failure);
const stat = (path: string) =>
  ResultAsync.fromPromise(
    lstat(path).then(
      (s) => ({ kind: "found" as const, stat: s }),
      (e: unknown) => ({
        kind: "error" as const,
        code: typeof e === "object" && e !== null && "code" in e ? e.code : null,
      }),
    ),
    failure,
  );
async function directory(path: string): Promise<Result<void, UploadFileError>> {
  const made = await io(() => mkdir(path, { recursive: true, mode: 0o700 }));
  if (made.isErr()) return err(made.error);
  const found = await stat(path);
  return found.isOk() &&
    found.value.kind === "found" &&
    found.value.stat.isDirectory() &&
    !found.value.stat.isSymbolicLink()
    ? syncDir(dirname(path))
    : err(conflict("upload directory is not a directory"));
}
function syncDir(path: string) {
  return io(async () => {
    const f = await open(path, constants.O_RDONLY);
    try {
      await f.sync();
    } finally {
      await f.close();
    }
  });
}
async function metadata<T>(path: string): Promise<Result<T | null, UploadFileError>> {
  const s = await stat(path);
  if (s.isErr()) return err(s.error);
  if (s.value.kind === "error") return s.value.code === "ENOENT" ? ok(null) : err(failure());
  if (!s.value.stat.isFile() || s.value.stat.size > 2048)
    return err(conflict("invalid upload metadata"));
  return io(async () => {
    const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return JSON.parse(await f.readFile("utf8")) as T;
    } finally {
      await f.close();
    }
  });
}
async function save(path: string, value: unknown, parent: string) {
  return io(async () => {
    const temp = `${path}.${randomUUID()}`;
    const f = await open(temp, "wx", 0o600);
    try {
      await f.writeFile(JSON.stringify(value));
      await f.sync();
    } finally {
      await f.close();
    }
    await rename(temp, path);
    const d = await open(parent, "r");
    try {
      await d.sync();
    } finally {
      await d.close();
    }
  });
}

/** Immutable, durably committed chunk files make an unacknowledged tail unambiguous. */
export class UploadFilesystem {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly workDir: string;
  constructor(workDir: string) {
    this.workDir = workDir;
  }
  run<T>(
    id: string,
    operation: () => Promise<Result<T, UploadFileError>>,
  ): ResultAsync<T, UploadFileError> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.then(operation);
    this.queues.set(id, next);
    void next.then(
      () => {
        if (this.queues.get(id) === next) this.queues.delete(id);
      },
      () => {
        if (this.queues.get(id) === next) this.queues.delete(id);
      },
    );
    return ResultAsync.fromPromise(next, failure).andThen((r) => r);
  }
  private staging(spec: UploadSpec) {
    return join(this.workDir, ".uploads", spec.id);
  }
  private destination(spec: UploadSpec) {
    return join(this.workDir, "uploads", spec.id, spec.name);
  }
  private async prepare(spec: UploadSpec): Promise<Result<void, UploadFileError>> {
    for (const dir of [
      join(this.workDir, ".uploads"),
      this.staging(spec),
      join(this.workDir, "uploads"),
      join(this.workDir, "uploads", spec.id),
    ]) {
      const result = await directory(dir);
      if (result.isErr()) return result;
    }
    const cancelled = await metadata<boolean>(join(this.staging(spec), "cancelled.json"));
    if (cancelled.isErr()) return err(cancelled.error);
    if (cancelled.value !== null) return err(conflict("upload was cancelled"));
    // Queue ownership proves these are debris from a terminated prior operation.
    const cleaned = await io(async () => {
      for (const name of await readdir(this.staging(spec)))
        if (name.endsWith(".partial") || name.startsWith("assembled."))
          await rm(join(this.staging(spec), name), { force: true });
    });
    if (cleaned.isErr()) return err(cleaned.error);
    const manifest = join(this.staging(spec), "manifest.json");
    const old = await metadata<UploadSpec>(manifest);
    if (old.isErr()) return err(old.error);
    if (old.value !== null)
      return JSON.stringify(old.value) === JSON.stringify(spec)
        ? ok(undefined)
        : err(conflict("upload identity already has different metadata"));
    return save(manifest, spec, this.staging(spec));
  }
  private async inspect(spec: UploadSpec): Promise<Result<UploadProgress, UploadFileError>> {
    // A prior caller may have lost its directory-flush result after rename.
    // Status acknowledgements must establish durability too, not merely stat visibility.
    const synced = await syncDir(this.staging(spec));
    if (synced.isErr()) return err(synced.error);
    const complete = await metadata<UploadProgress>(join(this.staging(spec), "complete.json"));
    if (complete.isErr()) return err(complete.error);
    if (complete.value !== null)
      return Check(UploadProgressSchema, complete.value) &&
        complete.value.offset === spec.size &&
        complete.value.path === this.destination(spec)
        ? ok(complete.value)
        : err(conflict("invalid upload completion metadata"));
    const entries = await io(() => readdir(this.staging(spec)));
    if (entries.isErr()) return err(entries.error);
    let offset = 0;
    for (const name of entries.value
      .filter((n) => /^\d+\.chunk$/.test(n))
      .sort((a, b) => Number(a.split(".")[0]) - Number(b.split(".")[0]))) {
      if (Number(name.split(".")[0]) !== offset)
        return err(conflict("noncontiguous upload chunks"));
      const size = await stat(join(this.staging(spec), name));
      if (
        size.isErr() ||
        size.value.kind !== "found" ||
        !size.value.stat.isFile() ||
        size.value.stat.size <= 0 ||
        size.value.stat.size > UPLOAD_CHUNK_BYTES
      )
        return err(conflict("invalid upload chunk"));
      offset += size.value.stat.size;
    }
    return offset <= spec.size
      ? ok({ offset, path: null, sha256: null })
      : err(conflict("upload exceeds declared size"));
  }
  status(spec: UploadSpec) {
    return this.run(spec.id, async () => {
      const p = await this.prepare(spec);
      return p.isErr() ? err(p.error) : this.inspect(spec);
    }).andThen((progress) => {
      if (progress.path !== null || progress.offset !== spec.size) return ok(progress);
      return stat(this.destination(spec)).andThen((found) =>
        found.kind === "found" ? this.finish(spec) : ok(progress),
      );
    });
  }
  chunk(spec: UploadSpec, offset: number, length: number, source: Readable) {
    return this.run(spec.id, async () => {
      const ready = await this.prepare(spec);
      if (ready.isErr()) return err(ready.error);
      const progress = await this.inspect(spec);
      if (progress.isErr()) return err(progress.error);
      if (
        progress.value.path !== null ||
        offset !== progress.value.offset ||
        length <= 0 ||
        length > UPLOAD_CHUNK_BYTES ||
        offset + length > spec.size
      )
        return err(conflict("upload offset or length does not match"));
      const temp = join(this.staging(spec), `${offset}.${randomUUID()}.partial`);
      const f = await io(() => open(temp, "wx", 0o600));
      if (f.isErr()) return err(f.error);
      const streamed = await io(async () => {
        let written = 0;
        for await (const chunk of source) {
          const bytes = chunk as Buffer;
          if (written + bytes.length > length) return false;
          let consumed = 0;
          while (consumed < bytes.length) {
            const w = await f.value.write(bytes, consumed, bytes.length - consumed);
            consumed += w.bytesWritten;
          }
          written += bytes.length;
        }
        if (written !== length) return false;
        await f.value.sync();
        return true;
      });
      const closed = await io(() => f.value.close());
      if (streamed.isErr() || !streamed.value || closed.isErr()) {
        await io(() => rm(temp, { force: true }));
        return err(
          streamed.isErr() ? streamed.error : conflict("upload chunk interrupted or wrong size"),
        );
      }
      const published = await io(() => rename(temp, join(this.staging(spec), `${offset}.chunk`)));
      if (published.isErr()) return err(published.error);
      const synced = await syncDir(this.staging(spec));
      return synced.isErr()
        ? err(synced.error)
        : ok({ offset: offset + length, path: null, sha256: null });
    });
  }
  finish(spec: UploadSpec) {
    return this.run(spec.id, async () => {
      const ready = await this.prepare(spec);
      if (ready.isErr()) return err(ready.error);
      const progress = await this.inspect(spec);
      if (progress.isErr()) return err(progress.error);
      if (progress.value.path !== null) return progress;
      if (progress.value.offset !== spec.size) return err(conflict("upload is incomplete"));
      const destination = this.destination(spec);
      const temp = join(this.staging(spec), `assembled.${randomUUID()}`);
      const assembled = await io(async () => {
        const output = await open(temp, "wx", 0o600);
        const hash = createHash("sha256");
        let offset = 0;
        const signal = AbortSignal.timeout(120_000);
        try {
          while (offset < spec.size) {
            const input = await open(
              join(this.staging(spec), `${offset}.chunk`),
              constants.O_RDONLY | constants.O_NOFOLLOW,
            );
            try {
              for await (const bytes of input.createReadStream({
                autoClose: false,
                highWaterMark: 64 * 1024,
                signal,
              })) {
                hash.update(bytes);
                await output.writeFile(bytes);
                offset += bytes.length;
              }
            } finally {
              await input.close();
            }
          }
          await output.sync();
        } finally {
          await output.close();
        }
        return hash.digest("hex");
      });
      if (assembled.isErr()) return err(assembled.error);
      // A hard link publishes without replacing a user file. Replay verifies an existing file.
      const linked = await ResultAsync.fromPromise(link(temp, destination), (e) => ({
        code: typeof e === "object" && e !== null && "code" in e ? e.code : null,
      }));
      if (linked.isErr()) {
        if (linked.error.code !== "EEXIST") return err(failure());
        const digest = await io(async () => {
          const h = createHash("sha256");
          const f = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            for await (const b of f.createReadStream({ autoClose: false })) h.update(b);
          } finally {
            await f.close();
          }
          return h.digest("hex");
        });
        if (digest.isErr() || digest.value !== assembled.value)
          return err(conflict("destination already exists with different bytes"));
      }
      const synced = await syncDir(join(this.workDir, "uploads", spec.id));
      if (synced.isErr()) return err(synced.error);
      const result = { offset: spec.size, path: destination, sha256: assembled.value };
      const saved = await save(
        join(this.staging(spec), "complete.json"),
        result,
        this.staging(spec),
      );
      if (saved.isErr()) return err(saved.error);
      await io(async () => {
        for (const name of await readdir(this.staging(spec)))
          if (name.endsWith(".chunk") || name.endsWith(".partial") || name.startsWith("assembled."))
            await rm(join(this.staging(spec), name), { force: true });
      });
      return ok(result);
    });
  }
  private cleanParts(spec: UploadSpec) {
    return io(async () => {
      for (const name of await readdir(this.staging(spec)))
        if (name.endsWith(".chunk") || name.endsWith(".partial") || name.startsWith("assembled."))
          await rm(join(this.staging(spec), name), { force: true });
    }).andThen(() => syncDir(this.staging(spec)));
  }
  cancel(spec: UploadSpec) {
    return this.run(spec.id, async () => {
      const tombstone = await metadata<boolean>(join(this.staging(spec), "cancelled.json"));
      if (tombstone.isErr()) return err(tombstone.error);
      if (tombstone.value === true) return this.cleanParts(spec);
      const ready = await this.prepare(spec);
      if (ready.isErr()) return err(ready.error);
      const done = await metadata<UploadProgress>(join(this.staging(spec), "complete.json"));
      if (done.isErr()) return err(done.error);
      if (done.value !== null) return err(conflict("file is already stored"));
      const destination = await stat(this.destination(spec));
      if (destination.isErr()) return err(destination.error);
      if (destination.value.kind === "found")
        return err(conflict("file is already published; refresh its status"));
      const saved = await save(
        join(this.staging(spec), "cancelled.json"),
        true,
        this.staging(spec),
      );
      if (saved.isErr()) return err(saved.error);
      return this.cleanParts(spec);
    });
  }
}

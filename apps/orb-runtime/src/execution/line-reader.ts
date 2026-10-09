import { type FileHandle, open } from "node:fs/promises";
import type { Context } from "@earendil-works/chord";
import {
  type Result as EnvResult,
  FileError,
  type TextLine,
  type TextLineReader,
} from "@earendil-works/pi-durable/env";
import { ResultAsync } from "neverthrow";

export const MAX_LINE_BYTES = 256 * 1024;
const fileError = (error: unknown, path: string): FileError =>
  new FileError(
    typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
      ? "not_found"
      : "unknown",
    "line reader I/O failed",
    path,
  );
/** Bounded LF reader: oversized lines fail, never silently truncate. */
export class BoundedLineReader implements TextLineReader {
  private readonly file: FileHandle;
  private readonly path: string;
  private readonly decoder = new TextDecoder();
  private readonly chunk = new Uint8Array(64 * 1024);
  private offset = 0;
  private buffered = "";
  private ended = false;
  private closed = false;
  private constructor(file: FileHandle, path: string) {
    this.file = file;
    this.path = path;
  }
  static async open(path: string): Promise<EnvResult<BoundedLineReader, FileError>> {
    const result = await ResultAsync.fromPromise(open(path, "r"), (error) =>
      fileError(error, path),
    );
    return result.isOk()
      ? { ok: true, value: new BoundedLineReader(result.value, path) }
      : { ok: false, error: result.error };
  }
  async readLine(context: Context): Promise<EnvResult<TextLine | undefined, FileError>> {
    while (true) {
      if (context.abortSignal?.aborted)
        return { ok: false, error: new FileError("aborted", "line read aborted", this.path) };
      if (this.closed)
        return { ok: false, error: new FileError("invalid", "line reader closed", this.path) };
      const newline = this.buffered.indexOf("\n");
      const length = newline < 0 ? this.buffered.length : newline;
      if (Buffer.byteLength(this.buffered.slice(0, length)) > MAX_LINE_BYTES) {
        await this.close(context);
        return {
          ok: false,
          error: new FileError("invalid", `line exceeds ${MAX_LINE_BYTES} bytes`, this.path),
        };
      }
      if (newline >= 0) {
        const text = this.buffered.slice(0, newline);
        this.buffered = this.buffered.slice(newline + 1);
        return { ok: true, value: { text, terminated: true } };
      }
      if (this.ended) {
        const text = this.buffered;
        this.buffered = "";
        return { ok: true, value: text ? { text, terminated: false } : undefined };
      }
      const read = await ResultAsync.fromPromise(
        this.file.read(this.chunk, 0, this.chunk.length, this.offset),
        (error) => fileError(error, this.path),
      );
      if (read.isErr()) return { ok: false, error: read.error };
      this.offset += read.value.bytesRead;
      this.ended = read.value.bytesRead === 0;
      this.buffered += this.ended
        ? this.decoder.decode()
        : this.decoder.decode(this.chunk.subarray(0, read.value.bytesRead), { stream: true });
    }
  }
  async close(_context: Context): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.buffered = "";
    await ResultAsync.fromPromise(this.file.close(), (error) => fileError(error, this.path));
  }
}

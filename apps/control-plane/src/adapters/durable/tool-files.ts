import { posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import { errAsync, okAsync, Result, type ResultAsync } from "neverthrow";
import type { ResourceReader } from "../../domain/resources.ts";
import type { AgentArtifacts } from "./persistence.ts";
import type { ToolError } from "./tools/catalog.ts";
import type { AgentToolFiles } from "./tools/files.ts";

const maxBytes = 50 * 1024;
const maxArtifactBytes = 16 * 1024 * 1024;
const failure = (message: string): ToolError => ({ code: "unavailable", message });
function imageMime(bytes: Uint8Array): string | undefined {
  const b = Buffer.from(bytes);
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(b.subarray(0, 6).toString())) return "image/gif";
  if (b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP")
    return "image/webp";
  return undefined;
}
function content(
  bytes: Uint8Array,
  request: { offset?: number; limit?: number },
): ResultAsync<ToolExecutionResult, ToolError> {
  if (bytes.byteLength > maxArtifactBytes) return errAsync(failure("File exceeds 16 MiB"));
  const mimeType = imageMime(bytes);
  if (mimeType)
    return okAsync({
      content: [{ type: "image", mimeType, data: Buffer.from(bytes).toString("base64") }],
    });
  const decoded = Result.fromThrowable(
    () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    () => failure("Unsupported file encoding or image format"),
  )();
  if (decoded.isErr()) return errAsync(decoded.error);
  if (decoded.value.includes("\u0000"))
    return errAsync(failure("Unsupported binary file or image format"));
  const offset = request.offset ?? 1;
  const limit = request.limit ?? 2000;
  if (!Number.isSafeInteger(offset) || offset < 1 || !Number.isSafeInteger(limit) || limit < 1)
    return errAsync({
      code: "invalid_arguments",
      message: "offset and limit must be positive integers",
    });
  const lines = decoded.value.split("\n");
  if (offset > lines.length)
    return errAsync({
      code: "invalid_arguments",
      message: `Offset ${offset} is beyond end of file (${lines.length} lines total)`,
    });
  const selected = lines.slice(offset - 1, offset - 1 + Math.min(limit, 2000));
  const output: string[] = [];
  let size = 0;
  let partial = false;
  for (const line of selected) {
    const length = Buffer.byteLength(line) + (output.length ? 1 : 0);
    if (size + length > maxBytes) {
      if (output.length === 0) {
        const buffer = Buffer.from(line);
        let end = maxBytes;
        while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end--;
        output.push(buffer.subarray(0, end).toString("utf8"));
        partial = true;
      }
      break;
    }
    output.push(line);
    size += length;
  }
  const more = partial || offset - 1 + output.length < lines.length;
  return okAsync({
    content: [{ type: "text", text: output.join("\n") }],
    diagnostics: more
      ? [
          {
            severity: "info",
            code: "truncated",
            message: partial
              ? "First line exceeds 50 KiB; showing a bounded prefix."
              : `Use offset=${offset + output.length} to continue (${lines.length} lines total).`,
          },
        ]
      : [],
  });
}

/** Adopted repository paths are a fallback, never an overlay over a ready mutable workspace. */
export function createAgentToolFiles(options: {
  reader: ResourceReader;
  artifacts: AgentArtifacts;
  allowSnapshotRead: () => boolean;
  check: () => ResultAsync<void, ToolError>;
}): Required<AgentToolFiles> {
  const check = (ctx: Context) =>
    ctx.abortSignal?.aborted
      ? errAsync<void, ToolError>({ code: "cancelled", message: "File operation cancelled" })
      : options.check();
  return {
    read: (request, _api, ctx) => {
      const artifact = request.path.startsWith("/orb-artifacts/");
      const platform =
        request.path.startsWith("/opt/pi-orb/skills/") ||
        posix.normalize(request.path).startsWith("/opt/pi-orb/skills/");
      if (
        !artifact &&
        !platform &&
        (!options.allowSnapshotRead() || !options.reader.contains(request.path))
      )
        return okAsync(undefined);
      return check(ctx)
        .andThen(() =>
          artifact
            ? options.artifacts
                .read(request.path)
                .mapErr(() => failure("Private artifact not found or access revoked"))
                .andThen((bytes) =>
                  bytes ? okAsync(bytes) : errAsync(failure("Private artifact not found")),
                )
            : options.reader
                .read(request.path)
                .mapErr(() => failure("Snapshot resource not found")),
        )
        .andThen((bytes) => check(ctx).andThen(() => content(bytes, request)));
    },
    spill: (text, _api, ctx) => {
      const bytes = Buffer.from(text, "utf8");
      if (bytes.byteLength > maxArtifactBytes) return errAsync(failure("Spill exceeds 16 MiB"));
      return check(ctx)
        .andThen(() =>
          options.artifacts.write(bytes).mapErr(() => failure("Private spill write failed")),
        )
        .andThen((path) => check(ctx).map(() => path));
    },
  };
}

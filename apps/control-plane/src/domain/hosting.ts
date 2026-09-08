import type { SimulationTask } from "determined";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import type { HostedByteSource, HostingDeps } from "./hosting-ports.ts";
import {
  HOSTED_FILE_MAX_BYTES,
  type HostedFile,
  type HostedObjectRef,
  type HostingError,
  type HostingUploadRequest,
} from "./hosting-types.ts";
import type { OperationContext } from "./ports.ts";

const invalid = (message: string): HostingError => ({ type: "hosting_invalid", message });
const hasUnsafePathCharacter = (path: string): boolean =>
  [...path].some((character) => {
    const code = character.charCodeAt(0);
    return character === "\\" || code < 32 || code === 127;
  });

function validate(request: HostingUploadRequest, maxFileBytes: number): HostingError | null {
  if (!Number.isSafeInteger(request.size) || request.size < 0 || request.size > maxFileBytes)
    return request.size > maxFileBytes
      ? { type: "hosting_too_large", message: `hosted file exceeds ${maxFileBytes} bytes` }
      : invalid("invalid hosted file size");
  if (
    request.path.length === 0 ||
    request.path.length > 1024 ||
    request.path.startsWith("/") ||
    hasUnsafePathCharacter(request.path) ||
    request.path.split("/").some((p) => p === "" || p === "." || p === "..")
  )
    return invalid("invalid hosted file path");
  if (
    request.mediaType.length === 0 ||
    request.mediaType.length > 255 ||
    /[\r\n]/.test(request.mediaType)
  )
    return invalid("invalid hosted file media type");
  if (!/^[a-f0-9]{64}$/.test(request.sha256)) return invalid("invalid hosted file SHA-256");
  return null;
}

export function publishHostedFile(
  task: SimulationTask,
  deps: HostingDeps,
  request: HostingUploadRequest,
  source: HostedByteSource,
  context: OperationContext,
): ResultAsync<HostedFile, HostingError> {
  const run = async (): Promise<Result<HostedFile, HostingError>> => {
    if (context.signal.aborted) {
      const closed = await source.close(task);
      if (closed.isErr()) return err(closed.error);
      return err({ type: "hosting_cancelled", message: "hosted file upload was cancelled" });
    }
    const validation = validate(request, deps.maxFileBytes ?? HOSTED_FILE_MAX_BYTES);
    if (validation !== null) {
      const closed = await source.close(task);
      return closed.isErr() ? err(closed.error) : err(validation);
    }
    const reserved = await deps.store.reserveUpload(task, request);
    if (reserved.isErr()) {
      const closed = await source.close(task);
      return closed.isErr() ? err(closed.error) : err(reserved.error);
    }
    const operation = reserved.value;
    if (operation.state === "published" && operation.publishedFile !== null) {
      const closed = await source.close(task);
      return closed.isErr() ? err(closed.error) : ok(operation.publishedFile);
    }
    let claimed = await deps.store.claimUpload(task, {
      operationId: operation.id,
      now: task.wallNow(),
      leaseUntil: task.wallNow() + deps.uploadLeaseMs,
    });
    if (claimed.isErr()) {
      const closed = await source.close(task);
      return closed.isErr() ? err(closed.error) : err(claimed.error);
    }
    if (claimed.value.type === "published") {
      const closed = await source.close(task);
      return closed.isErr() ? err(closed.error) : ok(claimed.value.file);
    }
    if (claimed.value.type === "busy") {
      const closed = await source.close(task);
      return closed.isErr()
        ? err(closed.error)
        : err({ type: "hosting_retryable", message: "upload is already in progress" });
    }
    let attempt = claimed.value.attempt;
    if (claimed.value.takeover) {
      if (attempt.sessionId !== null) {
        const terminal = await deps.bytes.cancel(task, attempt.sessionId, context);
        if (terminal.isErr()) {
          await source.close(task);
          return err(terminal.error);
        }
        if (terminal.value.type === "committed") {
          const recorded = await deps.store.recordCommit(
            task,
            attempt.id,
            attempt.epoch,
            terminal.value.object,
          );
          const closed = await source.close(task);
          if (recorded.isErr()) return err(recorded.error);
          if (closed.isErr()) return err(closed.error);
          return deps.store.publishUpload(
            task,
            operation.id,
            attempt.id,
            attempt.epoch,
            task.wallNow(),
          );
        }
      }
      const abandoned = await deps.store.abandonEmptyAttempt(task, attempt.id, attempt.epoch);
      if (abandoned.isErr()) {
        await source.close(task);
        return err(abandoned.error);
      }
      claimed = await deps.store.claimUpload(task, {
        operationId: operation.id,
        now: task.wallNow(),
        leaseUntil: task.wallNow() + deps.uploadLeaseMs,
      });
      if (claimed.isErr() || claimed.value.type !== "claimed") {
        await source.close(task);
        return claimed.isErr()
          ? err(claimed.error)
          : err({ type: "hosting_retryable", message: "upload recovery lost its claim" });
      }
      attempt = claimed.value.attempt;
    }

    if (attempt.sessionId === null) {
      await task.checkpoint("hosting.before-session-begin");
      const begun = await deps.bytes.begin(
        task,
        attempt.objectKey,
        { size: request.size, sha256: request.sha256 },
        context,
      );
      if (begun.isErr()) {
        await deps.store.abandonEmptyAttempt(task, attempt.id, attempt.epoch);
        const closed = await source.close(task);
        return closed.isErr() ? err(closed.error) : err(begun.error);
      }
      await task.checkpoint("hosting.before-session-register");
      const registered = await deps.store.registerSession(
        task,
        attempt.id,
        attempt.epoch,
        begun.value.sessionId,
      );
      if (registered.isErr()) {
        const cancelled = await deps.bytes.cancel(task, begun.value.sessionId, context);
        if (cancelled.isOk()) await deps.store.abandonEmptyAttempt(task, attempt.id, attempt.epoch);
        const closed = await source.close(task);
        if (closed.isErr()) return err(closed.error);
        return cancelled.isErr() ? err(cancelled.error) : err(registered.error);
      }
      attempt = registered.value;
      await task.checkpoint("hosting.session-registered");
    }

    let storedObject = attempt.committedObject;
    if (storedObject === null) {
      const written = await deps.bytes.write(
        task,
        attempt.sessionId as string,
        source,
        { size: request.size, sha256: request.sha256 },
        context,
      );
      if (written.isErr()) {
        if (written.error.type !== "hosting_retryable") return err(written.error);
        const queried = await deps.bytes.query(task, attempt.sessionId as string, context);
        if (queried.isErr() || queried.value.type !== "committed") return err(written.error);
        storedObject = queried.value.object;
      } else storedObject = written.value;
      await task.checkpoint("hosting.provider-committed");
      const recorded = await deps.store.recordCommit(task, attempt.id, attempt.epoch, storedObject);
      if (recorded.isErr()) return err(recorded.error);
    } else {
      const closed = await source.close(task);
      if (closed.isErr()) return err(closed.error);
    }
    await task.checkpoint("hosting.before-publish");
    return deps.store.publishUpload(task, operation.id, attempt.id, attempt.epoch, task.wallNow());
  };
  return new ResultAsync(run());
}

export const listHostedFiles = (task: SimulationTask, deps: HostingDeps, orbId: string) =>
  deps.store.listFiles(task, orbId);

export const getHostedFileInventory = (task: SimulationTask, deps: HostingDeps, orbId: string) =>
  deps.store.getInventory(task, orbId);

export const resolveHostedFile = (
  task: SimulationTask,
  deps: HostingDeps,
  orbId: string,
  path: string,
) => deps.store.resolveFile(task, orbId, path);

export function openHostedFileSnapshot(
  task: SimulationTask,
  deps: HostingDeps,
  file: HostedFile,
  context: OperationContext,
) {
  const run = async (): Promise<
    Result<{ file: HostedFile; source: HostedByteSource }, HostingError>
  > => {
    const result = await deps.bytes.openExact(task, file.object, context);
    if (result.isErr()) return err(result.error);
    const opened = result.value;
    if (
      opened.object.ref.key !== file.object.key ||
      opened.object.ref.generation !== file.object.generation ||
      opened.object.size !== file.size ||
      opened.object.sha256 !== file.sha256
    ) {
      const closed = await opened.source.close(task);
      return closed.isErr()
        ? err(closed.error)
        : err({
            type: "hosting_corruption" as const,
            message: "hosted object metadata does not match its catalog entry",
          });
    }
    return ok({ file, source: opened.source });
  };
  return new ResultAsync(run());
}

export function removeHostedFile(
  task: SimulationTask,
  deps: HostingDeps,
  caller: {
    readonly orbId: string;
    readonly runtimeTokenHash: string;
    readonly incarnation: number;
  },
  path: string,
  expected?: HostedObjectRef,
): ResultAsync<void, HostingError> {
  return deps.store.unpublishExact(task, caller, path, expected);
}

export function cleanupHostedFiles(
  task: SimulationTask,
  deps: HostingDeps,
  orbId: string,
  context: OperationContext,
): ResultAsync<void, HostingError> {
  const run = async (): Promise<Result<void, HostingError>> => {
    const begun = await deps.store.beginOrbCleanup(task, orbId);
    if (begun.isErr()) return err(begun.error);
    for (;;) {
      const pass = await cleanupRetiredHostedFiles(
        task,
        deps,
        { leaseMs: deps.uploadLeaseMs, limit: 100, orbId },
        context,
      );
      if (pass.isErr()) return err(pass.error);
      if (pass.value === 0) break;
    }
    return deps.store.finishOrbCleanup(task, orbId);
  };
  return new ResultAsync(run());
}

/** One bounded pass for replacement/removal garbage while the orb remains live. */
export function cleanupRetiredHostedFiles(
  task: SimulationTask,
  deps: HostingDeps,
  params: {
    readonly leaseMs: number;
    readonly limit: number;
    readonly orbId?: string;
  },
  context: OperationContext,
): ResultAsync<number, HostingError> {
  const run = async (): Promise<Result<number, HostingError>> => {
    const claimed = await deps.store.claimCleanup(task, {
      ...(params.orbId === undefined ? {} : { orbId: params.orbId }),
      now: task.wallNow(),
      leaseUntil: task.wallNow() + params.leaseMs,
      limit: params.limit,
    });
    if (claimed.isErr()) return err(claimed.error);
    for (const item of claimed.value) {
      const fail = async (error: HostingError): Promise<Result<number, HostingError>> => {
        const recorded = await deps.store.recordCleanupFailure(
          task,
          item.id,
          item.epoch,
          error.message,
          task.wallNow(),
        );
        return recorded.isErr() ? err(recorded.error) : err(error);
      };
      let object = item.object;
      if (item.sessionId !== null) {
        const terminal = await deps.bytes.cancel(task, item.sessionId, context);
        if (terminal.isErr()) return fail(terminal.error);
        if (terminal.value.type === "committed") {
          if (
            object !== null &&
            (object.key !== terminal.value.object.ref.key ||
              object.generation !== terminal.value.object.ref.generation)
          )
            return fail({
              type: "hosting_corruption",
              message: "cleanup session committed a different object generation",
            });
          object = terminal.value.object.ref;
          const recorded = await deps.store.recordCleanupObject(task, item.id, item.epoch, object);
          if (recorded.isErr()) return fail(recorded.error);
        }
      }
      if (object !== null) {
        const deleted = await deps.bytes.deleteExact(task, object, context);
        if (deleted.isErr()) return fail(deleted.error);
        const absent = await deps.bytes.statExact(task, object, context);
        if (absent.isErr()) return fail(absent.error);
        if (absent.value !== null)
          return fail({
            type: "hosting_retryable",
            message: "hosted object remains after deletion",
          });
      }
      const finished = await deps.store.finishClaimedCleanup(task, item.id, item.epoch);
      if (finished.isErr()) return err(finished.error);
    }
    return ok(claimed.value.length);
  };
  return new ResultAsync(run());
}

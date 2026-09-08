import { createHash } from "node:crypto";
import { ApplicationFailure, type SimulationTask } from "determined";
import { err, errAsync, ok, okAsync, ResultAsync } from "neverthrow";
import { openHostedFileSnapshot, resolveHostedFile } from "../domain/hosting.ts";
import type {
  HostedByteSource,
  HostedByteStore,
  HostingDeps,
  HostingStore,
} from "../domain/hosting-ports.ts";
import type {
  HostedFile,
  HostedObjectRef,
  HostingAttempt,
  HostingCleanupItem,
  HostingError,
  HostingOperation,
  HostingUploadRequest,
  StoredHostedObject,
} from "../domain/hosting-types.ts";
import type { OperationContext } from "../domain/ports.ts";
import { FAILPOINTS } from "./failpoints.ts";

const failure = (message: string): HostingError => ({ type: "hosting_retryable", message });
const sameRef = (a: HostedObjectRef, b: HostedObjectRef) =>
  a.key === b.key && a.generation === b.generation;

export function openHostedFile(
  task: SimulationTask,
  deps: HostingDeps,
  orbId: string,
  path: string,
  context: OperationContext,
) {
  const run = async () => {
    const resolved = await resolveHostedFile(task, deps, orbId, path);
    if (resolved.isErr()) return err(resolved.error);
    if (resolved.value === null)
      return err({ type: "hosting_not_found" as const, message: "hosted file does not exist" });
    return await openHostedFileSnapshot(task, deps, resolved.value, context);
  };
  return new ResultAsync(run());
}

export function source(text: string): HostedByteSource & { pulled(): number; closed(): number } {
  const chunks = [new TextEncoder().encode(text)];
  let reads = 0;
  let closes = 0;
  return {
    pulled: () => reads,
    closed: () => closes,
    next: () => {
      reads++;
      return okAsync(chunks.shift() ?? null);
    },
    close: () => {
      closes++;
      return okAsync(undefined);
    },
  };
}

function chunkSource(stored: readonly Uint8Array[]): HostedByteSource {
  const chunks = stored.map((chunk) => chunk.slice());
  return {
    next: () => okAsync(chunks.shift() ?? null),
    close: () => okAsync(undefined),
  };
}

class FakeBytes implements HostedByteStore {
  private sequence = 0;
  observe: () => void = () => undefined;
  loseNextBegin = false;
  interruptNextRead = false;
  readonly sessions = new Map<
    string,
    {
      key: string;
      expected: { size: number; sha256: string };
      state: "active" | "cancelled" | "committed";
      object: StoredHostedObject | null;
      bytes: number;
      chunks: Uint8Array[];
    }
  >();
  readonly objects = new Map<string, { metadata: StoredHostedObject; chunks: Uint8Array[] }>();
  begin(task: SimulationTask, key: string, expected: { size: number; sha256: string }) {
    return ResultAsync.fromPromise(
      (async () => {
        await task.failpoint(FAILPOINTS.hostingSessionBegin, key);
        const sessionId = `session-${++this.sequence}`;
        this.sessions.set(sessionId, {
          key,
          expected,
          state: "active",
          object: null,
          bytes: 0,
          chunks: [],
        });
        this.observe();
        if (this.loseNextBegin) {
          this.loseNextBegin = false;
          throw new ApplicationFailure("session begin response was lost");
        }
        return { sessionId };
      })(),
      (error) =>
        error instanceof ApplicationFailure
          ? failure(`session begin failed: ${error.message}`)
          : task.abortSimulation(error),
    );
  }
  write(
    task: SimulationTask,
    sessionId: string,
    input: HostedByteSource,
    expected: { size: number; sha256: string },
    context: { signal: AbortSignal },
  ) {
    const run = async () => {
      const session = this.sessions.get(sessionId);
      if (session === undefined || session.state !== "active")
        return err<StoredHostedObject, HostingError>(failure("session is not active"));
      if (session.expected.size !== expected.size || session.expected.sha256 !== expected.sha256)
        return err<StoredHostedObject, HostingError>({
          type: "hosting_conflict",
          message: "write integrity differs from session",
        });
      const digest = createHash("sha256");
      for (;;) {
        if (context.signal.aborted) {
          await input.close(task);
          return err<StoredHostedObject, HostingError>({
            type: "hosting_cancelled",
            message: "hosted byte write was cancelled",
          });
        }
        await task.failpoint(FAILPOINTS.hostingChunk, sessionId);
        await task.checkpoint("hosting.fake.before-chunk");
        const next = await input.next(task, context);
        if (next.isErr()) {
          await input.close(task);
          return err<StoredHostedObject, HostingError>(next.error);
        }
        if (next.value === null) break;
        session.bytes += next.value.byteLength;
        digest.update(next.value);
        session.chunks.push(next.value.slice());
        this.observe();
      }
      await input.close(task);
      if (session.state !== "active")
        return err<StoredHostedObject, HostingError>(failure("session was cancelled"));
      const actualHash = digest.digest("hex");
      if (session.bytes !== expected.size || actualHash !== expected.sha256)
        return err<StoredHostedObject, HostingError>({
          type: "hosting_corruption",
          message: "hosted bytes do not match declared size and digest",
        });
      const object = { key: session.key, generation: `generation-${++this.sequence}` };
      session.state = "committed";
      const stored = { ref: object, size: expected.size, sha256: expected.sha256 };
      session.object = stored;
      this.objects.set(`${object.key}@${object.generation}`, {
        metadata: stored,
        chunks: session.chunks,
      });
      this.observe();
      await task.failpoint(FAILPOINTS.hostingProviderFinalize, sessionId);
      return ok<StoredHostedObject, HostingError>(stored);
    };
    return ResultAsync.fromPromise(run(), (error) =>
      error instanceof ApplicationFailure
        ? failure(`hosted byte operation failed: ${error.message}`)
        : task.abortSimulation(error),
    ).andThen((result) => result);
  }
  query(_task: SimulationTask, id: string) {
    const s = this.sessions.get(id);
    if (s === undefined) return errAsync(failure("unknown session"));
    return okAsync(
      s.state === "committed"
        ? {
            type: "committed" as const,
            object: s.object as StoredHostedObject,
          }
        : ({ type: s.state } as const),
    );
  }
  cancel(task: SimulationTask, id: string) {
    const s = this.sessions.get(id);
    if (s === undefined) return errAsync(failure("unknown session"));
    if (s.state === "committed")
      return okAsync({
        type: "committed" as const,
        object: s.object as StoredHostedObject,
      });
    return ResultAsync.fromPromise(
      (async () => {
        await task.failpoint(FAILPOINTS.hostingCancel, id);
        s.state = "cancelled";
        this.observe();
        return { type: "cancelled" as const };
      })(),
      (error) =>
        error instanceof ApplicationFailure
          ? failure(`session cancellation failed: ${error.message}`)
          : task.abortSimulation(error),
    );
  }
  statExact(_task: SimulationTask, object: HostedObjectRef) {
    return okAsync(this.objects.get(`${object.key}@${object.generation}`)?.metadata ?? null);
  }
  openExact(_task: SimulationTask, ref: HostedObjectRef) {
    const stored = this.objects.get(`${ref.key}@${ref.generation}`);
    const interrupt = this.interruptNextRead;
    this.interruptNextRead = false;
    let delivered = false;
    return stored === undefined
      ? errAsync<{ object: StoredHostedObject; source: HostedByteSource }, HostingError>(
          failure("object is absent"),
        )
      : okAsync({
          object: stored.metadata,
          source: interrupt
            ? {
                next: () => {
                  if (!delivered) {
                    delivered = true;
                    return okAsync(stored.chunks[0]?.slice() ?? new Uint8Array());
                  }
                  return errAsync<Uint8Array | null, HostingError>(
                    failure("exact read was interrupted"),
                  );
                },
                close: () => okAsync(undefined),
              }
            : chunkSource(stored.chunks),
        });
  }
  deleteExact(task: SimulationTask, object: HostedObjectRef) {
    return ResultAsync.fromPromise(
      (async () => {
        await task.failpoint(FAILPOINTS.hostingDeleteExact, object.key);
        this.objects.delete(`${object.key}@${object.generation}`);
        this.observe();
      })(),
      (error) =>
        error instanceof ApplicationFailure
          ? failure(`exact deletion failed: ${error.message}`)
          : task.abortSimulation(error),
    );
  }
}

class FakeStore implements HostingStore {
  observe: () => void = () => undefined;
  readonly operations = new Map<string, HostingOperation>();
  readonly attempts = new Map<string, HostingAttempt>();
  readonly attemptLeases = new Map<string, number>();
  readonly files = new Map<string, HostedFile>();
  readonly cleanup = new Map<string, HostingCleanupItem>();
  readonly cleanupClaims = new Map<string, { epoch: number; leaseUntil: number }>();
  readonly cleanupErrors = new Map<string, { message: string; at: number }>();
  readonly cleanupOperations = new Map<string, string>();
  readonly events: string[] = [];
  readonly cleanupBegun = new Set<string>();
  deleting = false;
  lifecycle: "active" | "archiving" | "deleting" = "active";
  attemptSequence = 0;
  readonly orbId: string;
  readonly failRegistration: boolean;
  readonly externalAuthority:
    | ((orbId: string) => {
        state: string;
        runtimeTokenHash: string | null;
        hostIncarnation: number;
        hostDiscardThroughIncarnation?: number | null;
      } | null)
    | undefined;
  constructor(
    orbId: string,
    failRegistration: boolean,
    externalAuthority?: (orbId: string) => {
      state: string;
      runtimeTokenHash: string | null;
      hostIncarnation: number;
      hostDiscardThroughIncarnation?: number | null;
    } | null,
  ) {
    this.orbId = orbId;
    this.failRegistration = failRegistration;
    this.externalAuthority = externalAuthority;
  }
  private authority(orbId: string) {
    if (this.externalAuthority !== undefined) return this.externalAuthority(orbId);
    return {
      state: this.lifecycle === "active" ? "running" : this.lifecycle,
      runtimeTokenHash: "token",
      hostIncarnation: 1,
      hostDiscardThroughIncarnation: null,
    };
  }
  private acceptsRuntime(orbId: string, token: string, incarnation: number): boolean {
    const authority = this.authority(orbId);
    return (
      authority !== null &&
      authority.state === "running" &&
      authority.runtimeTokenHash === token &&
      authority.hostIncarnation === incarnation &&
      (authority.hostDiscardThroughIncarnation === null ||
        authority.hostDiscardThroughIncarnation === undefined ||
        authority.hostDiscardThroughIncarnation < incarnation)
    );
  }
  private fileKey(orbId: string, path: string): string {
    return `${orbId}:${path}`;
  }
  reserveUpload(_task: SimulationTask, request: HostingUploadRequest) {
    const authority = this.authority(request.orbId);
    if (
      authority === null ||
      authority.runtimeTokenHash !== request.runtimeTokenHash ||
      authority.hostIncarnation !== request.incarnation
    )
      return errAsync<HostingOperation, HostingError>({
        type: "hosting_unauthorized",
        message: "runtime authority is stale",
      });
    if (!this.acceptsRuntime(request.orbId, request.runtimeTokenHash, request.incarnation))
      return errAsync<HostingOperation, HostingError>({
        type: "hosting_conflict",
        message: "orb does not accept hosted-file writes",
      });
    const key = `${request.orbId}:${request.requestId}`;
    const prior = this.operations.get(key);
    if (prior !== undefined) {
      if (JSON.stringify(prior.request) !== JSON.stringify(request))
        return errAsync<HostingOperation, HostingError>({
          type: "hosting_conflict",
          message: "request id parameters differ",
        });
      return okAsync(prior);
    }
    const operation: HostingOperation = {
      id: key,
      request,
      state: "reserved",
      publishedFile: null,
    };
    this.operations.set(key, operation);
    return okAsync(operation);
  }
  claimUpload(
    _task: SimulationTask,
    params: { operationId: string; now: number; leaseUntil: number },
  ) {
    const operation = this.operations.get(params.operationId);
    if ([...this.cleanupOperations.values()].includes(params.operationId))
      return okAsync({ type: "busy" as const });
    if (operation?.publishedFile !== null && operation?.publishedFile !== undefined)
      return okAsync({ type: "published" as const, file: operation.publishedFile });
    let attempt = [...this.attempts.values()].find((a) => a.operationId === params.operationId);
    const priorLease = attempt === undefined ? undefined : this.attemptLeases.get(attempt.id);
    if (attempt !== undefined && priorLease !== undefined && priorLease > params.now)
      return okAsync({ type: "busy" as const });
    const takeover = attempt !== undefined;
    if (takeover && attempt !== undefined) {
      attempt = { ...attempt, epoch: attempt.epoch + 1 };
      this.attempts.set(attempt.id, attempt);
    }
    if (attempt === undefined) {
      const sequence = ++this.attemptSequence;
      attempt = {
        id: `attempt:${params.operationId}:${sequence}`,
        operationId: params.operationId,
        objectKey: `${operation?.request.orbId ?? this.orbId}/attempts/${sequence}`,
        epoch: 1,
        state: "beginning",
        sessionId: null,
        committedObject: null,
      };
      this.attempts.set(attempt.id, attempt);
    }
    this.attemptLeases.set(attempt.id, params.leaseUntil);
    return okAsync({ type: "claimed" as const, attempt, takeover });
  }
  abandonEmptyAttempt(_task: SimulationTask, id: string, epoch: number) {
    if (this.attempts.get(id)?.epoch !== epoch)
      return errAsync<void, HostingError>({
        type: "hosting_conflict",
        message: "stale attempt epoch",
      });
    this.attempts.delete(id);
    return okAsync(undefined);
  }
  registerSession(task: SimulationTask, id: string, epoch: number, sessionId: string) {
    const attempt = this.attempts.get(id);
    const operation = attempt === undefined ? undefined : this.operations.get(attempt.operationId);
    if (
      operation === undefined ||
      !this.acceptsRuntime(
        operation.request.orbId,
        operation.request.runtimeTokenHash,
        operation.request.incarnation,
      )
    )
      return errAsync<HostingAttempt, HostingError>({
        type: "hosting_conflict",
        message: "orb deletion is in progress",
      });
    if (this.failRegistration)
      return errAsync<HostingAttempt, HostingError>(failure("session registration failed"));
    return ResultAsync.fromPromise(
      (async () => {
        await task.failpoint(FAILPOINTS.hostingSessionRegisterBefore, id);
        const updated = await this.updateAttempt(id, epoch, {
          state: "session_ready",
          sessionId,
        });
        if (updated.isErr()) return updated;
        this.observe();
        await task.failpoint(FAILPOINTS.hostingSessionRegisterAfter, id);
        return updated;
      })(),
      (error) =>
        error instanceof ApplicationFailure
          ? failure(`session registration failed: ${error.message}`)
          : task.abortSimulation(error),
    ).andThen((result) => result);
  }
  recordCommit(_task: SimulationTask, id: string, epoch: number, object: StoredHostedObject) {
    const initialAttempt = this.attempts.get(id);
    const initialOperation =
      initialAttempt === undefined ? undefined : this.operations.get(initialAttempt.operationId);
    if (
      initialOperation === undefined ||
      !this.acceptsRuntime(
        initialOperation.request.orbId,
        initialOperation.request.runtimeTokenHash,
        initialOperation.request.incarnation,
      )
    )
      return errAsync<HostingAttempt, HostingError>({
        type: "hosting_conflict",
        message: "orb deletion is in progress",
      });
    const attempt = this.attempts.get(id);
    const operation = attempt === undefined ? undefined : this.operations.get(attempt.operationId);
    if (
      attempt === undefined ||
      operation === undefined ||
      object.ref.key !== attempt.objectKey ||
      object.size !== operation.request.size ||
      object.sha256 !== operation.request.sha256
    )
      return errAsync<HostingAttempt, HostingError>({
        type: "hosting_corruption",
        message: "committed object does not match its upload operation",
      });
    return this.updateAttempt(id, epoch, { state: "committed", committedObject: object });
  }
  publishUpload(task: SimulationTask, id: string, attemptId: string, epoch: number, now: number) {
    const operation = this.operations.get(id);
    const attempt = this.attempts.get(attemptId);
    if (
      operation === undefined ||
      attempt?.committedObject === null ||
      attempt?.committedObject === undefined
    )
      return errAsync<HostedFile, HostingError>(failure("upload is not committed"));
    if (attempt.epoch !== epoch)
      return errAsync<HostedFile, HostingError>({
        type: "hosting_conflict",
        message: "stale attempt epoch",
      });
    if (
      !this.acceptsRuntime(
        operation.request.orbId,
        operation.request.runtimeTokenHash,
        operation.request.incarnation,
      )
    )
      return errAsync<HostedFile, HostingError>({
        type: "hosting_conflict",
        message: "runtime authority is stale",
      });
    if (operation.publishedFile !== null) return okAsync(operation.publishedFile);
    const committedObject = attempt.committedObject;
    return ResultAsync.fromPromise(
      (async () => {
        await task.failpoint(FAILPOINTS.hostingPublishBefore, id);
        const fileKey = this.fileKey(operation.request.orbId, operation.request.path);
        const existing = this.files.get(fileKey);
        const file: HostedFile = {
          orbId: operation.request.orbId,
          path: operation.request.path,
          object: committedObject.ref,
          size: operation.request.size,
          mediaType: operation.request.mediaType,
          sha256: operation.request.sha256,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        this.files.set(fileKey, file);
        if (existing !== undefined)
          this.cleanup.set(`retired:${existing.object.key}@${existing.object.generation}`, {
            id: `retired:${existing.object.key}@${existing.object.generation}`,
            orbId: existing.orbId,
            path: existing.path,
            sessionId: null,
            object: existing.object,
          });
        const next = { ...operation, state: "published" as const, publishedFile: file };
        this.operations.set(id, next);
        this.events.push("published");
        this.attempts.delete(attemptId);
        this.attemptLeases.delete(attemptId);
        this.observe();
        await task.failpoint(FAILPOINTS.hostingPublishAfter, id);
        return file;
      })(),
      (error) =>
        error instanceof ApplicationFailure
          ? failure(`publish response lost: ${error.message}`)
          : task.abortSimulation(error),
    );
  }
  listFiles(_task: SimulationTask, orbId: string) {
    return okAsync([...this.files.values()].filter((file) => file.orbId === orbId));
  }
  getInventory(_task: SimulationTask, orbId: string) {
    return okAsync({
      files: [...this.files.values()].filter((file) => file.orbId === orbId),
      cleanupIssues: [...this.cleanup.values()].flatMap((item) => {
        const error = this.cleanupErrors.get(item.id);
        return item.orbId === orbId && error !== undefined
          ? [{ path: item.path, lastError: error.message, lastErrorAt: error.at }]
          : [];
      }),
    });
  }
  resolveFile(_task: SimulationTask, orbId: string, path: string) {
    const file = this.files.get(this.fileKey(orbId, path));
    return okAsync(file?.orbId === orbId ? file : null);
  }
  unpublishExact(
    _task: SimulationTask,
    _caller: { orbId: string; runtimeTokenHash: string; incarnation: number },
    path: string,
    expected: HostedObjectRef | undefined,
  ) {
    const authority = this.authority(_caller.orbId);
    if (
      authority === null ||
      authority.runtimeTokenHash !== _caller.runtimeTokenHash ||
      authority.hostIncarnation !== _caller.incarnation
    )
      return errAsync<void, HostingError>({
        type: "hosting_unauthorized",
        message: "runtime authority is stale",
      });
    if (!this.acceptsRuntime(_caller.orbId, _caller.runtimeTokenHash, _caller.incarnation))
      return errAsync<void, HostingError>({
        type: "hosting_conflict",
        message: "orb does not accept hosted-file writes",
      });
    const fileKey = this.fileKey(_caller.orbId, path);
    const current = this.files.get(fileKey);
    if (current !== undefined && (expected === undefined || sameRef(current.object, expected))) {
      this.files.delete(fileKey);
      this.cleanup.set(`removed:${current.object.key}@${current.object.generation}`, {
        id: `removed:${current.object.key}@${current.object.generation}`,
        orbId: current.orbId,
        path: current.path,
        sessionId: null,
        object: current.object,
      });
      this.events.push("removed");
    }
    return okAsync(undefined);
  }
  beginOrbCleanup(_task: SimulationTask, orbId: string) {
    this.deleting = true;
    this.lifecycle = "deleting";
    this.cleanupBegun.add(orbId);
    for (const attempt of this.attempts.values()) {
      const operation = this.operations.get(attempt.operationId);
      if (operation?.request.orbId !== orbId) continue;
      this.cleanup.set(`attempt:${attempt.id}`, {
        id: `attempt:${attempt.id}`,
        orbId,
        path: operation.request.path,
        sessionId: attempt.sessionId,
        object: attempt.committedObject?.ref ?? null,
      });
    }
    for (const file of this.files.values()) {
      if (file.orbId !== orbId) continue;
      this.cleanup.set(`file:${file.orbId}:${file.path}`, {
        id: `file:${file.orbId}:${file.path}`,
        orbId,
        path: file.path,
        sessionId: null,
        object: file.object,
      });
    }
    return okAsync(undefined);
  }
  claimCleanup(
    _task: SimulationTask,
    params: { orbId?: string; now: number; leaseUntil: number; limit: number },
  ) {
    for (const attempt of this.attempts.values()) {
      const lease = this.attemptLeases.get(attempt.id);
      if (lease !== undefined && lease > params.now) continue;
      const operation = this.operations.get(attempt.operationId);
      if (
        operation === undefined ||
        (params.orbId !== undefined && operation.request.orbId !== params.orbId)
      )
        continue;
      const id = `attempt:${attempt.id}`;
      this.cleanup.set(id, {
        id,
        orbId: operation.request.orbId,
        path: operation.request.path,
        sessionId: attempt.sessionId,
        object: attempt.committedObject?.ref ?? null,
      });
      this.cleanupOperations.set(id, attempt.operationId);
      this.attempts.delete(attempt.id);
      this.attemptLeases.delete(attempt.id);
    }
    const claimed = [];
    for (const item of this.cleanup.values()) {
      if (params.orbId !== undefined && item.orbId !== params.orbId) continue;
      const prior = this.cleanupClaims.get(item.id);
      if (prior !== undefined && prior.leaseUntil > params.now) continue;
      const epoch = (prior?.epoch ?? 0) + 1;
      this.cleanupClaims.set(item.id, { epoch, leaseUntil: params.leaseUntil });
      claimed.push({ ...item, epoch });
      if (claimed.length === params.limit) break;
    }
    return okAsync(claimed);
  }
  recordCleanupFailure(
    _task: SimulationTask,
    id: string,
    _epoch: number,
    message: string,
    now: number,
  ) {
    if (this.cleanupErrors.get(id)?.message !== message) this.events.push("cleanup_blocked");
    this.cleanupErrors.set(id, { message, at: now });
    return okAsync(undefined);
  }
  recordCleanupObject(_task: SimulationTask, id: string, epoch: number, object: HostedObjectRef) {
    const item = this.cleanup.get(id);
    if (item === undefined || this.cleanupClaims.get(id)?.epoch !== epoch)
      return errAsync<void, HostingError>({
        type: "hosting_conflict",
        message: "stale cleanup claim",
      });
    if (item.object !== null && !sameRef(item.object, object))
      return errAsync<void, HostingError>({
        type: "hosting_conflict",
        message: "cleanup object generation differs",
      });
    this.cleanup.set(id, { ...item, object });
    this.events.push(`cleanup_object:${object.key}@${object.generation}`);
    this.observe();
    return okAsync(undefined);
  }
  finishClaimedCleanup(task: SimulationTask, id: string, epoch: number) {
    if (this.cleanupClaims.get(id)?.epoch !== epoch)
      return errAsync<void, HostingError>({
        type: "hosting_conflict",
        message: "stale cleanup claim",
      });
    this.cleanup.delete(id);
    this.cleanupClaims.delete(id);
    this.cleanupErrors.delete(id);
    this.cleanupOperations.delete(id);
    this.events.push("cleanup_completed");
    this.observe();
    return ResultAsync.fromPromise(
      (async () => {
        await task.failpoint(FAILPOINTS.hostingCleanupFinishAfter, id);
      })(),
      (error) =>
        error instanceof ApplicationFailure
          ? failure(`cleanup acknowledgment lost: ${error.message}`)
          : task.abortSimulation(error),
    );
  }
  finishOrbCleanup(_task: SimulationTask, orbId: string) {
    const hasInventory =
      [...this.files.values()].some((file) => file.orbId === orbId) ||
      [...this.operations.values()].some((operation) => operation.request.orbId === orbId) ||
      [...this.attempts.values()].some(
        (attempt) => this.operations.get(attempt.operationId)?.request.orbId === orbId,
      );
    if (!this.cleanupBegun.has(orbId) && hasInventory)
      return errAsync<void, HostingError>({
        type: "hosting_conflict",
        message: "hosting inventory remains",
      });
    if ([...this.cleanup.values()].some((item) => item.orbId === orbId))
      return errAsync(failure("cleanup remains"));
    for (const [key, file] of this.files) if (file.orbId === orbId) this.files.delete(key);
    for (const [key, operation] of this.operations)
      if (operation.request.orbId === orbId) this.operations.delete(key);
    this.cleanupBegun.delete(orbId);
    return okAsync(undefined);
  }
  private updateAttempt(id: string, epoch: number, fields: Partial<HostingAttempt>) {
    const current = this.attempts.get(id);
    if (current === undefined)
      return errAsync<HostingAttempt, HostingError>(failure("unknown attempt"));
    if (current.epoch !== epoch)
      return errAsync<HostingAttempt, HostingError>({
        type: "hosting_conflict",
        message: "stale attempt epoch",
      });
    const next = { ...current, ...fields } as HostingAttempt;
    this.attempts.set(id, next);
    this.observe();
    return okAsync(next);
  }
}

export function makeHostingHarness(
  options: {
    failSessionRegistration?: boolean;
    uploadLeaseMs?: number;
    observeBoundaries?: boolean;
    orbId?: string;
    authority?: (orbId: string) => {
      state: string;
      runtimeTokenHash: string | null;
      hostIncarnation: number;
      hostDiscardThroughIncarnation?: number | null;
    } | null;
  } = {},
) {
  const orbId = options.orbId ?? "00000000-0000-4000-8000-000000000071";
  const store = new FakeStore(orbId, options.failSessionRegistration === true, options.authority);
  const bytes = new FakeBytes();
  const request = (requestId: string): HostingUploadRequest => ({
    orbId,
    runtimeTokenHash: "token",
    incarnation: 1,
    requestId,
    path: "index.html",
    size: 5,
    mediaType: "text/html",
    sha256: createHash("sha256")
      .update(requestId === "request-b" ? "bravo" : "alpha")
      .digest("hex"),
  });
  const observeOwnership = () => {
    const owners = new Map<string, number>();
    const add = (ref: HostedObjectRef | null | undefined) => {
      if (ref === null || ref === undefined) return;
      const key = `${ref.key}@${ref.generation}`;
      owners.set(key, (owners.get(key) ?? 0) + 1);
    };
    for (const file of store.files.values()) {
      add(file.object);
      if (!bytes.objects.has(`${file.object.key}@${file.object.generation}`))
        throw new Error(`catalog points to absent hosted object ${file.object.key}`);
    }
    for (const item of store.cleanup.values()) add(item.object);
    for (const attempt of store.attempts.values()) {
      add(attempt.committedObject?.ref);
      if (
        attempt.committedObject !== null &&
        !bytes.objects.has(
          `${attempt.committedObject.ref.key}@${attempt.committedObject.ref.generation}`,
        )
      )
        throw new Error(`attempt points to absent hosted object ${attempt.objectKey}`);
    }
    for (const [sessionId, session] of bytes.sessions) {
      const durableOwners = [...store.attempts.values()].filter(
        (attempt) => attempt.sessionId === sessionId && attempt.objectKey === session.key,
      );
      if (session.state === "active" && session.bytes > 0 && durableOwners.length !== 1)
        throw new Error(`data-capable session ${sessionId} has ${durableOwners.length} owners`);
      if (session.state === "committed" && session.object !== null) {
        const recoveryOwners = durableOwners.filter((attempt) => attempt.committedObject === null);
        if (recoveryOwners.length > 1)
          throw new Error(`committed session ${sessionId} has duplicate recovery owners`);
        if (recoveryOwners.length === 1) add(session.object.ref);
      }
    }
    for (const key of bytes.objects.keys()) {
      if (owners.get(key) !== 1)
        throw new Error(`hosted object ${key} has ${owners.get(key) ?? 0} durable owners`);
    }
  };
  if (options.observeBoundaries !== false) {
    store.observe = observeOwnership;
    bytes.observe = observeOwnership;
  }
  return {
    orbId,
    deps: {
      store,
      bytes,
      uploadLeaseMs: options.uploadLeaseMs ?? 60_000,
    } satisfies HostingDeps,
    request,
    current: (path: string) => store.files.get(`${orbId}:${path}`),
    dataCapableSessions: () =>
      [...bytes.sessions.values()].filter((s) => s.state === "active" && s.bytes > 0).length,
    ownedObjects: () => [...bytes.objects.keys()],
    events: () => [...store.events],
    cleanupErrors: () => [...store.cleanupErrors.values()].map((error) => error.message),
    assertOwnership: observeOwnership,
    seedInterruptedUpload: () => {
      const req = request("interrupted");
      const op: HostingOperation = {
        id: `${orbId}:interrupted`,
        request: req,
        state: "uploading",
        publishedFile: null,
      };
      const attempt: HostingAttempt = {
        id: `attempt:${op.id}`,
        operationId: op.id,
        objectKey: `${orbId}/attempts/interrupted`,
        epoch: 1,
        state: "session_ready",
        sessionId: "seed-session",
        committedObject: null,
      };
      store.operations.set(op.id, op);
      store.attempts.set(attempt.id, attempt);
      bytes.sessions.set("seed-session", {
        key: attempt.objectKey,
        expected: { size: req.size, sha256: req.sha256 },
        state: "active",
        object: null,
        bytes: 3,
        chunks: [new TextEncoder().encode("alp")],
      });
    },
    seedCompletedUpload: () => {
      const req = request("completed");
      const op: HostingOperation = {
        id: `${orbId}:completed`,
        request: req,
        state: "uploading",
        publishedFile: null,
      };
      const ref = { key: `${orbId}/attempts/completed`, generation: "late-generation" };
      const object: StoredHostedObject = { ref, size: req.size, sha256: req.sha256 };
      const attempt: HostingAttempt = {
        id: `attempt:${op.id}`,
        operationId: op.id,
        objectKey: ref.key,
        epoch: 1,
        state: "committed",
        sessionId: "completed-session",
        committedObject: object,
      };
      store.operations.set(op.id, op);
      store.attempts.set(attempt.id, attempt);
      bytes.sessions.set("completed-session", {
        key: ref.key,
        expected: { size: req.size, sha256: req.sha256 },
        state: "committed",
        object,
        bytes: req.size,
        chunks: [new TextEncoder().encode("alpha")],
      });
      bytes.objects.set(`${ref.key}@${ref.generation}`, {
        metadata: object,
        chunks: [new TextEncoder().encode("alpha")],
      });
    },
    setLifecycle: (state: "active" | "archiving" | "deleting") => {
      store.lifecycle = state;
    },
    loseNextBegin: () => {
      bytes.loseNextBegin = true;
    },
    interruptNextRead: () => {
      bytes.interruptNextRead = true;
    },
  };
}

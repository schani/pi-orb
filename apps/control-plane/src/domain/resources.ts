import { posix } from "node:path";
import { err, errAsync, okAsync, type Result, ResultAsync } from "neverthrow";

export type ResourceError = {
  type: "resource_error";
  code:
    | "cancelled"
    | "authentication"
    | "fetch"
    | "invalid"
    | "limit"
    | "storage"
    | "conflict"
    | "not_found";
  message: string;
};
export const resourceError = (code: ResourceError["code"], message: string): ResourceError => ({
  type: "resource_error",
  code,
  message,
});
export interface ResourceFile {
  path: string;
  bytes: Uint8Array;
  sha256: string;
}
export interface ResourceSnapshot {
  orbId: string;
  commitSha: string;
  instructionPath: string | null;
  skillRoot: string | null;
  files: ResourceFile[];
}
export interface ResourceSnapshotStore {
  get(orbId: string): ResultAsync<ResourceSnapshot | null, ResourceError>;
  put(snapshot: ResourceSnapshot): ResultAsync<ResourceSnapshot, ResourceError>;
  remove(orbId: string): ResultAsync<void, ResourceError>;
}
export interface ResourceSource {
  acquire(input: {
    orbId: string;
    url: string;
    signal: AbortSignal;
  }): ResultAsync<ResourceSnapshot, ResourceError>;
}
export type ResourceStatus =
  | { phase: "acquiring" }
  | { phase: "ready"; commitSha: string; fileCount: number; byteCount: number }
  | { phase: "failed"; code: ResourceError["code"] };
export interface ResourceStatusPort {
  record(orbId: string, status: ResourceStatus): ResultAsync<void, ResourceError>;
}
/** Every caller retains its own cancellation authority; publication is immutable. */
export class ResourceAcquisition {
  private readonly store: ResourceSnapshotStore;
  private readonly source: ResourceSource;
  private readonly status: ResourceStatusPort | undefined;
  constructor(store: ResourceSnapshotStore, source: ResourceSource, status?: ResourceStatusPort) {
    this.store = store;
    this.source = source;
    this.status = status;
  }
  acquire(input: {
    orbId: string;
    url: string;
    signal: AbortSignal;
  }): ResultAsync<ResourceSnapshot, ResourceError> {
    if (input.signal.aborted)
      return errAsync(resourceError("cancelled", "Resource acquisition cancelled"));
    const pending = this.store
      .get(input.orbId)
      .andThen((snapshot) => {
        if (input.signal.aborted)
          return errAsync(resourceError("cancelled", "Resource acquisition cancelled"));
        if (snapshot) return okAsync(snapshot);
        return (this.status?.record(input.orbId, { phase: "acquiring" }) ?? okAsync(undefined))
          .andThen(() => this.source.acquire(input))
          .andThen((value) =>
            input.signal.aborted
              ? errAsync(resourceError("cancelled", "Resource acquisition cancelled"))
              : this.store.put(value),
          );
      })
      .andThen((value) =>
        input.signal.aborted
          ? errAsync(resourceError("cancelled", "Resource acquisition cancelled"))
          : (
              this.status?.record(input.orbId, {
                phase: "ready",
                commitSha: value.commitSha,
                fileCount: value.files.length,
                byteCount: value.files.reduce((sum, file) => sum + file.bytes.byteLength, 0),
              }) ?? okAsync(undefined)
            ).map(() => value),
      )
      .orElse((error) =>
        (
          this.status?.record(input.orbId, { phase: "failed", code: error.code }) ??
          okAsync(undefined)
        ).andThen(() => errAsync(error)),
      );
    const wait = new Promise<Result<ResourceSnapshot, ResourceError>>((resolve) => {
      const abort = () =>
        resolve(err(resourceError("cancelled", "Resource acquisition cancelled")));
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) abort();
      void pending.then((result) => {
        input.signal.removeEventListener("abort", abort);
        resolve(result);
      });
    });
    return ResultAsync.fromSafePromise(wait).andThen((result) => result);
  }
}
export interface ResourceReader {
  contains(path: string): boolean;
  read(path: string): ResultAsync<Uint8Array, ResourceError>;
}
export class SnapshotResourceReader implements ResourceReader {
  private readonly files: Map<string, Uint8Array>;
  constructor(snapshot: ResourceSnapshot) {
    this.files = new Map(snapshot.files.map((file) => [file.path, Uint8Array.from(file.bytes)]));
  }
  contains(path: string): boolean {
    return this.files.has(posix.normalize(path));
  }
  read(path: string): ResultAsync<Uint8Array, ResourceError> {
    const bytes = this.files.get(posix.normalize(path));
    return bytes
      ? okAsync(Uint8Array.from(bytes))
      : errAsync(resourceError("not_found", "Path is not in the adopted resource snapshot"));
  }
}
/** Only exact adopted resource paths are readable; never falls through to a host filesystem. */
export function readResource(
  snapshot: ResourceSnapshot,
  path: string,
): ResultAsync<Uint8Array, ResourceError> {
  const file = snapshot.files.find((file) => file.path === path);
  return file
    ? okAsync(Uint8Array.from(file.bytes))
    : errAsync(resourceError("not_found", "Path is not in the adopted resource snapshot"));
}

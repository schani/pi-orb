import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SimulationTask } from "determined";
import { ResultAsync } from "neverthrow";
import type { StoreError } from "../../domain/errors.ts";
import type { CredentialSecretStore, StoredCredential, StoredSecret } from "../../domain/ports.ts";

const unavailable = (message: string): StoreError => ({
  type: "store_error",
  code: "unavailable",
  message,
  retryable: true,
});

const toStoreError = (reason: string) => (error: unknown) =>
  unavailable(`${reason}: ${error instanceof Error ? error.message : String(error)}`);

/**
 * File-backed credential secret store for local development
 * (docs/credentials.md): one JSON file per immutable version under a private directory,
 * mode 0600. The cloud deployment replaces this with a Secret-Manager-backed
 * implementation; the pointer row's `secret_version` addresses both the same
 * way.
 */
export class FileSecretStore implements CredentialSecretStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private path(provider: string, version: string): string {
    return join(this.dir, `${provider}-${version}.json`);
  }

  writeSecret<T extends StoredSecret = StoredCredential>(
    _task: SimulationTask,
    provider: string,
    credential: T,
  ): ResultAsync<{ version: string }, StoreError> {
    const version = `v-${randomBytes(8).toString("hex")}`;
    return ResultAsync.fromPromise(
      (async () => {
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
        await writeFile(this.path(provider, version), JSON.stringify(credential), { mode: 0o600 });
        return { version };
      })(),
      toStoreError("write secret"),
    );
  }

  readSecret<T extends StoredSecret = StoredCredential>(
    _task: SimulationTask,
    provider: string,
    version: string,
  ): ResultAsync<T | null, StoreError> {
    return ResultAsync.fromPromise(
      readFile(this.path(provider, version), "utf8").then(
        (raw) => JSON.parse(raw) as T,
        (error: unknown) =>
          (error as NodeJS.ErrnoException).code === "ENOENT" ? null : Promise.reject(error),
      ),
      toStoreError("read secret"),
    );
  }

  listSecretVersions(_task: SimulationTask, provider: string): ResultAsync<string[], StoreError> {
    return ResultAsync.fromPromise(
      readdir(this.dir).then(
        (names) => {
          const prefix = `${provider}-`;
          return names
            .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
            .map((name) => name.slice(prefix.length, -".json".length))
            .sort();
        },
        (error: unknown) =>
          (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : Promise.reject(error),
      ),
      toStoreError("list secret versions"),
    );
  }

  destroySecret(
    _task: SimulationTask,
    provider: string,
    version: string,
  ): ResultAsync<void, StoreError> {
    return ResultAsync.fromPromise(
      unlink(this.path(provider, version)).catch((error: unknown) =>
        (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : Promise.reject(error),
      ),
      toStoreError("destroy secret"),
    );
  }
}

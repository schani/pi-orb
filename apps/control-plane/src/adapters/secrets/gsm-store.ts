import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
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

export interface GsmSecretStoreOptions {
  readonly projectId: string;
  /**
   * The parent secret's id per provider, e.g. "pi-orb-credential". The
   * secret itself is created by the OpenTofu plane (adding a version cannot
   * create the parent); this adapter only adds, reads, and destroys
   * versions on it.
   */
  readonly secretPrefix: string;
}

/**
 * Secret-Manager-backed credential secret store (docs/credentials.md): one
 * pre-created secret per provider, one immutable version per credential
 * generation. The pointer row addresses exact numeric versions — never
 * `latest`, whose consistency is not guaranteed.
 */
export class GsmSecretStore implements CredentialSecretStore {
  private readonly client = new SecretManagerServiceClient();
  private readonly options: GsmSecretStoreOptions;

  constructor(options: GsmSecretStoreOptions) {
    this.options = options;
  }

  private parent(provider: string): string {
    return `projects/${this.options.projectId}/secrets/${this.options.secretPrefix}-${provider}`;
  }

  writeSecret<T extends StoredSecret = StoredCredential>(
    _task: SimulationTask,
    provider: string,
    credential: T,
  ): ResultAsync<{ version: string }, StoreError> {
    return ResultAsync.fromPromise(
      this.client
        .addSecretVersion({
          parent: this.parent(provider),
          payload: { data: Buffer.from(JSON.stringify(credential), "utf8") },
        })
        .then(([version]) => {
          const name = version.name ?? "";
          const numeric = name.split("/").at(-1) ?? "";
          if (numeric === "") return Promise.reject(new Error("version name missing"));
          return { version: numeric };
        }),
      toStoreError("add secret version"),
    );
  }

  readSecret<T extends StoredSecret = StoredCredential>(
    _task: SimulationTask,
    provider: string,
    version: string,
  ): ResultAsync<T | null, StoreError> {
    return ResultAsync.fromPromise(
      this.client
        .accessSecretVersion({ name: `${this.parent(provider)}/versions/${version}` })
        .then(([response]): T | null => {
          const data = response.payload?.data;
          if (data === null || data === undefined) return null;
          return JSON.parse(Buffer.from(data).toString("utf8")) as T;
        })
        .catch((error: unknown) => {
          // A destroyed or absent version is definitive null, not an outage.
          const code = (error as { code?: number }).code;
          if (code === 5 || code === 9) return null; // NOT_FOUND, FAILED_PRECONDITION
          return Promise.reject(error);
        }),
      toStoreError("access secret version"),
    );
  }

  destroySecret(
    _task: SimulationTask,
    provider: string,
    version: string,
  ): ResultAsync<void, StoreError> {
    return ResultAsync.fromPromise(
      this.client
        .destroySecretVersion({ name: `${this.parent(provider)}/versions/${version}` })
        .then(() => undefined)
        .catch((error: unknown) => {
          const code = (error as { code?: number }).code;
          if (code === 5 || code === 9) return undefined; // already gone
          return Promise.reject(error);
        }),
      toStoreError("destroy secret version"),
    );
  }
}

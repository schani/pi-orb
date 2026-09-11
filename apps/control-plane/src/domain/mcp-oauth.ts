import type { SimulationTask } from "determined";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import { getToken, type TokenGrant, type TokenRequest } from "./broker.ts";
import { DEFAULT_BROKER_CONSTANTS } from "./constants.ts";
import type {
  CredentialPointerRow,
  CredentialPointerWrite,
  CredentialSecretStore,
  StoredCredential,
  StoredSecret,
  UpstreamRefresher,
} from "./ports.ts";

export const MCP_OAUTH_SECRETS = "mcp-oauth";
export const MCP_LOGIN_TTL = 10 * 60_000;
export interface McpOAuthError {
  readonly type: "mcp_oauth_error";
  readonly code: "not_found" | "conflict" | "unavailable" | "auth_required" | "invalid_request";
}
export const oauthError = (code: McpOAuthError["code"]): McpOAuthError => ({
  type: "mcp_oauth_error",
  code,
});
export interface McpOAuthBinding {
  projectId: string;
  id: string;
  url: string;
}
export interface McpOAuthAttempt {
  id: string;
  browser: string;
  expiresAt: number;
  phase: "preparing" | "pending" | "exchanging";
  secretVersion: string | null;
}
export interface McpOAuthRow extends CredentialPointerRow {
  attempt: McpOAuthAttempt | null;
}
export type McpOAuthNext = Omit<McpOAuthRow, "provider" | "rowVersion">;
/** Every read/write checks the active project and exact configured ID/URL binding. */
export interface McpOAuthStore {
  read(
    task: SimulationTask,
    binding: McpOAuthBinding,
  ): Promise<Result<McpOAuthRow | null, McpOAuthError>>;
  cas(
    task: SimulationTask,
    binding: McpOAuthBinding,
    expected: number | null,
    next: McpOAuthNext,
    edge: string | null,
  ): Promise<Result<McpOAuthRow, McpOAuthError>>;
}
/** Opaque SDK state is secret-store-only, never part of the domain's database row. */
export interface StoredMcpOAuth extends StoredCredential {
  projectId: string;
  connectionId: string;
  oauth: Record<string, unknown>;
}
export interface McpOAuthProtocol {
  prepare(
    task: SimulationTask,
    binding: McpOAuthBinding,
    state: string,
  ): Promise<Result<{ url: string; secret: StoredMcpOAuth }, McpOAuthError>>;
  exchange(
    task: SimulationTask,
    secret: StoredMcpOAuth,
    code: string,
    issuer?: string,
  ): Promise<Result<StoredMcpOAuth, McpOAuthError>>;
  refresher: UpstreamRefresher;
}
const empty: McpOAuthNext = {
  generation: 0,
  secretVersion: null,
  refreshLeaseUntil: 0,
  lastRefreshAt: 0,
  attempt: null,
};

/** Durable single-use browser ceremonies; refresh ownership stays in the existing broker. */
export class McpOAuth {
  readonly store: McpOAuthStore;
  readonly secrets: CredentialSecretStore;
  readonly protocol: McpOAuthProtocol;
  constructor(store: McpOAuthStore, secrets: CredentialSecretStore, protocol: McpOAuthProtocol) {
    this.store = store;
    this.secrets = secrets;
    this.protocol = protocol;
  }

  private async write(task: SimulationTask, secret: StoredMcpOAuth, binding: McpOAuthBinding) {
    const active = await this.store.read(task, binding);
    if (active.isErr()) return err(active.error);
    return (await this.secrets.writeSecret(task, MCP_OAUTH_SECRETS, secret)).mapErr(() =>
      oauthError("unavailable"),
    );
  }
  private async retire(task: SimulationTask, row: McpOAuthRow | null) {
    for (const version of new Set([row?.secretVersion, row?.attempt?.secretVersion])) {
      if (version) await this.secrets.destroySecret(task, MCP_OAUTH_SECRETS, version);
    }
  }
  private async load(task: SimulationTask, version: string) {
    const result = await this.secrets.readSecret<StoredMcpOAuth>(task, MCP_OAUTH_SECRETS, version);
    return result.isErr() || !result.value ? err(oauthError("unavailable")) : ok(result.value);
  }
  /** A lost CAS acknowledgement is resolved by exact secret-version readback. */
  private async publish(
    task: SimulationTask,
    binding: McpOAuthBinding,
    row: McpOAuthRow,
    next: McpOAuthNext,
    edge: string,
  ) {
    const committed = await this.store.cas(task, binding, row.rowVersion, next, edge);
    if (committed.isOk() || committed.error.code !== "unavailable") return committed;
    const read = await this.store.read(task, binding);
    if (
      read.isOk() &&
      read.value &&
      read.value.generation === next.generation &&
      read.value.secretVersion === next.secretVersion &&
      read.value.attempt?.secretVersion === next.attempt?.secretVersion &&
      read.value.attempt?.phase === next.attempt?.phase
    )
      return ok(read.value);
    return committed;
  }
  async start(
    task: SimulationTask,
    binding: McpOAuthBinding,
    id: string,
    browser: string,
  ): Promise<Result<{ url: string }, McpOAuthError>> {
    const read = await this.store.read(task, binding);
    if (read.isErr()) return err(read.error);
    const current = read.value ?? empty;
    const claimed = await this.store.cas(
      task,
      binding,
      read.value?.rowVersion ?? null,
      {
        ...empty,
        generation: current.generation + 1,
        attempt: {
          id,
          browser,
          expiresAt: task.wallNow() + MCP_LOGIN_TTL,
          phase: "preparing",
          secretVersion: null,
        },
      },
      "started",
    );
    if (claimed.isErr()) return err(claimed.error);
    const prepared = await this.protocol.prepare(task, binding, id);
    if (prepared.isErr()) {
      await this.store.cas(
        task,
        binding,
        claimed.value.rowVersion,
        { ...empty, generation: claimed.value.generation },
        `failed:${prepared.error.code}`,
      );
      return prepared;
    }
    const saved = await this.write(task, prepared.value.secret, binding);
    if (saved.isErr()) {
      await this.store.cas(
        task,
        binding,
        claimed.value.rowVersion,
        { ...empty, generation: claimed.value.generation },
        `failed:${saved.error.code}`,
      );
      return err(saved.error);
    }
    const published = await this.publish(
      task,
      binding,
      claimed.value,
      {
        ...claimed.value,
        attempt: {
          id,
          browser,
          expiresAt: task.wallNow() + MCP_LOGIN_TTL,
          phase: "pending",
          secretVersion: saved.value.version,
        },
      },
      "pending",
    );
    if (published.isOk()) await this.retire(task, read.value);
    return published.isErr() ? err(published.error) : ok({ url: prepared.value.url });
  }
  async complete(
    task: SimulationTask,
    binding: McpOAuthBinding,
    id: string,
    browser: string,
    code: string,
    issuer?: string,
  ): Promise<Result<void, McpOAuthError>> {
    const read = await this.store.read(task, binding);
    if (read.isErr()) return err(read.error);
    const row = read.value;
    const attempt = row?.attempt;
    if (
      !row ||
      !attempt ||
      attempt.id !== id ||
      attempt.browser !== browser ||
      attempt.expiresAt <= task.wallNow() ||
      attempt.phase !== "pending" ||
      !attempt.secretVersion
    )
      return err(oauthError("invalid_request"));
    const claimed = await this.store.cas(
      task,
      binding,
      row.rowVersion,
      { ...row, attempt: { ...attempt, phase: "exchanging" } },
      "exchanging",
    );
    if (claimed.isErr()) return err(claimed.error);
    if (!code) {
      const denied = await this.store.cas(
        task,
        binding,
        claimed.value.rowVersion,
        { ...empty, generation: row.generation },
        "denied",
      );
      return denied.isErr() ? err(denied.error) : err(oauthError("auth_required"));
    }
    const secret = await this.load(task, attempt.secretVersion);
    if (secret.isErr()) {
      await this.store.cas(
        task,
        binding,
        claimed.value.rowVersion,
        { ...empty, generation: row.generation },
        "failed:secret_unavailable",
      );
      return err(secret.error);
    }
    const exchanged = await this.protocol.exchange(task, secret.value, code, issuer);
    if (exchanged.isErr()) {
      await this.store.cas(
        task,
        binding,
        claimed.value.rowVersion,
        { ...empty, generation: row.generation },
        `failed:${exchanged.error.code}`,
      );
      return err(exchanged.error);
    }
    let version: string | null = null;
    for (let i = 0; i < 3 && !version; i++) {
      const saved = await this.write(task, exchanged.value, binding);
      if (saved.isOk()) version = saved.value.version;
      else await task.sleep(100, "mcp credential persistence retry");
    }
    if (!version) {
      await this.store.cas(
        task,
        binding,
        claimed.value.rowVersion,
        { ...empty, generation: row.generation },
        "credential_lost",
      );
      return err(oauthError("auth_required"));
    }
    const committed = await this.publish(
      task,
      binding,
      claimed.value,
      { ...empty, generation: row.generation + 1, secretVersion: version },
      "connected",
    );
    if (committed.isOk()) await this.retire(task, row);
    return committed.isErr() ? err(committed.error) : ok(undefined);
  }
  async disconnect(
    task: SimulationTask,
    binding: McpOAuthBinding,
  ): Promise<Result<void, McpOAuthError>> {
    const read = await this.store.read(task, binding);
    if (read.isErr()) return err(read.error);
    const result = await this.store.cas(
      task,
      binding,
      read.value?.rowVersion ?? null,
      { ...empty, generation: (read.value?.generation ?? 0) + 1 },
      "disconnected",
    );
    if (result.isOk()) await this.retire(task, read.value);
    return result.isErr() ? err(result.error) : ok(undefined);
  }
  async status(
    task: SimulationTask,
    binding: McpOAuthBinding,
  ): Promise<Result<"connected" | "pending" | "auth_required", McpOAuthError>> {
    const read = await this.store.read(task, binding);
    if (read.isErr()) return err(read.error);
    const row = read.value;
    if (row?.attempt && row.attempt.expiresAt <= task.wallNow()) {
      const expired = await this.store.cas(
        task,
        binding,
        row.rowVersion,
        { ...empty, generation: row.generation + 1 },
        "expired",
      );
      if (expired.isErr()) return err(expired.error);
      return ok("auth_required");
    }
    return ok(row?.attempt ? "pending" : row?.secretVersion ? "connected" : "auth_required");
  }
  async token(
    task: SimulationTask,
    binding: McpOAuthBinding,
    request: TokenRequest,
  ): Promise<Result<TokenGrant, McpOAuthError>> {
    const storeError = () => ({
      type: "store_error" as const,
      code: "unavailable" as const,
      message: "MCP OAuth unavailable",
      retryable: true,
    });
    const scopedSecrets: CredentialSecretStore = {
      writeSecret: (t, _p, value) =>
        ResultAsync.fromSafePromise(this.store.read(t, binding)).andThen((active) =>
          active.isErr()
            ? err(storeError())
            : this.secrets.writeSecret(t, MCP_OAUTH_SECRETS, value),
        ),
      readSecret: <T extends StoredSecret = StoredCredential>(
        t: SimulationTask,
        _p: string,
        version: string,
      ) =>
        this.secrets
          .readSecret<T>(t, MCP_OAUTH_SECRETS, version)
          .andThen((value) =>
            value &&
            (!("projectId" in value) ||
              value.projectId !== binding.projectId ||
              !("connectionId" in value) ||
              value.connectionId !== binding.id)
              ? err(storeError())
              : ok(value),
          ),
      listSecretVersions: (t) => this.secrets.listSecretVersions(t, MCP_OAUTH_SECRETS),
      destroySecret: (t, _p, version) => this.secrets.destroySecret(t, MCP_OAUTH_SECRETS, version),
    };
    const result = await getToken(
      task,
      {
        constants: DEFAULT_BROKER_CONSTANTS,
        secrets: scopedSecrets,
        upstreams: { [binding.id]: this.protocol.refresher },
        pointers: {
          readPointer: (t) =>
            ResultAsync.fromSafePromise(this.store.read(t, binding)).andThen((r) =>
              r.isErr()
                ? r.error.code === "not_found"
                  ? ok(null)
                  : err(storeError())
                : ok(r.value),
            ),
          casWritePointer: (t, _p, expected, next: CredentialPointerWrite) =>
            ResultAsync.fromSafePromise(
              (async () => {
                const read = await this.store.read(t, binding);
                if (read.isErr() || read.value?.rowVersion !== expected)
                  return err({ type: "pointer_conflict" as const });
                const previous = read.value;
                const written = await this.store.cas(
                  t,
                  binding,
                  expected,
                  { ...next, attempt: previous.attempt },
                  next.secretVersion === null
                    ? "invalidated"
                    : next.generation > previous.generation
                      ? "refreshed"
                      : previous.refreshLeaseUntil > 0 && next.refreshLeaseUntil === 0
                        ? "refresh_failed"
                        : null,
                );
                return written.mapErr((e) =>
                  e.code === "unavailable" ? storeError() : { type: "pointer_conflict" as const },
                );
              })(),
            ).andThen((result) => result),
        },
      },
      binding.id,
      request,
    );
    return result.mapErr((e) =>
      oauthError(e.type === "auth_required" ? "auth_required" : "unavailable"),
    );
  }
}

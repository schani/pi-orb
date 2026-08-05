import type { SimulationTask } from "determined";
import { ResultAsync } from "neverthrow";
import type { UpstreamRefreshError } from "../../domain/errors.ts";
import type { OperationContext, StoredCredential, UpstreamRefresher } from "../../domain/ports.ts";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REAL_OAUTH_BASE_URL = "https://auth.openai.com";

export interface OAuthRefresherOptions {
  /** OAuth origin; the fake service's per-session URL in E2E mode. */
  readonly oauthBaseUrl?: string;
}

const transient = (message: string, retryAfterMs?: number): UpstreamRefreshError => ({
  type: "upstream_transient",
  message,
  ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
});

class RefreshFailure extends Error {
  readonly typed: UpstreamRefreshError;
  constructor(typed: UpstreamRefreshError) {
    super(typed.message);
    this.typed = typed;
  }
}

/**
 * The control plane's upstream OAuth refresh (docs/credentials.md): the standard
 * rotating `refresh_token` grant, form-encoded, against the real Codex OAuth
 * origin or the fake service. This is the only place a refresh token crosses
 * the network, and it never leaves this process in any other direction.
 */
export class OAuthUpstreamRefresher implements UpstreamRefresher {
  private readonly oauthBaseUrl: string;

  constructor(options: OAuthRefresherOptions = {}) {
    this.oauthBaseUrl = options.oauthBaseUrl ?? REAL_OAUTH_BASE_URL;
  }

  refresh(
    task: SimulationTask,
    credential: StoredCredential,
    context: OperationContext,
  ): ResultAsync<StoredCredential, UpstreamRefreshError> {
    // Failures travel as rejections carrying the typed error; the mapper
    // below is the single exception boundary of this adapter.
    const fail = (typed: UpstreamRefreshError): Promise<never> =>
      Promise.reject(new RefreshFailure(typed));
    const run = async (): Promise<StoredCredential> => {
      const form = new URLSearchParams({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: credential.refresh,
      });
      const response = await fetch(`${this.oauthBaseUrl}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        signal: context.signal,
      });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        if (body["error"] === "invalid_grant") {
          return fail({
            type: "invalid_grant",
            message: String(body["error_description"] ?? "invalid_grant"),
          });
        }
        const retryAfterHeader = response.headers.get("retry-after");
        const retryAfterMs =
          retryAfterHeader !== null && /^\d+$/.test(retryAfterHeader)
            ? Number(retryAfterHeader) * 1000
            : undefined;
        return fail(transient(`refresh failed with HTTP ${response.status}`, retryAfterMs));
      }
      const access = body["access_token"];
      const refresh = body["refresh_token"];
      if (typeof access !== "string" || typeof refresh !== "string") {
        return fail(transient("refresh response missing tokens"));
      }
      const expiresIn = typeof body["expires_in"] === "number" ? body["expires_in"] : 3600;
      return {
        access,
        refresh,
        accountId: credential.accountId,
        expiresAt: task.wallNow() + expiresIn * 1000,
      };
    };
    return ResultAsync.fromPromise(run(), (error): UpstreamRefreshError => {
      if (error instanceof RefreshFailure) return error.typed;
      return transient(error instanceof Error ? error.message : String(error));
    });
  }
}

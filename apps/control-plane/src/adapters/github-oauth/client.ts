import type { SimulationTask } from "determined";
import { ResultAsync } from "neverthrow";
import type { UpstreamRefreshError } from "../../domain/errors.ts";
import type {
  GithubDeviceGrant,
  GithubOAuthClient,
  GithubOAuthTransientError,
  GithubPollOutcome,
} from "../../domain/github-auth.ts";
import type { OperationContext, StoredCredential, UpstreamRefresher } from "../../domain/ports.ts";

/**
 * GitHub App OAuth adapters (DESIGN.md §15.3): the device flow the auth gate
 * drives and the rotating user-token refresh the broker drives. GitHub's
 * OAuth endpoints answer errors as HTTP 200 with an `error` field, so both
 * paths inspect the body, not just the status. The client secret is used
 * only for refresh (the device grant needs the client id alone) and never
 * leaves this process; refresh tokens cross the network only here.
 */

const REAL_OAUTH_BASE_URL = "https://github.com";
const REAL_API_BASE_URL = "https://api.github.com";

/** Fallback lifetimes for apps with token expiration disabled: an access
 * token GitHub will not expire gets a nominal 8-hour broker lifetime, and a
 * missing refresh token forces re-login when it "expires" — acceptable POC
 * degradation; the app is expected to have expiration enabled. */
const FALLBACK_ACCESS_TTL_S = 8 * 3600;

export interface GithubOAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /** OAuth origin override (tests). */
  readonly oauthBaseUrl?: string;
  /** REST API origin override (tests). */
  readonly apiBaseUrl?: string;
}

const transientOauth = (message: string): GithubOAuthTransientError => ({
  type: "github_oauth_transient",
  message,
});

class OAuthFailure extends Error {
  readonly typed: GithubOAuthTransientError;
  constructor(typed: GithubOAuthTransientError) {
    super(typed.message);
    this.typed = typed;
  }
}

async function postForm(
  url: string,
  form: URLSearchParams,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
    ...(signal !== undefined ? { signal } : {}),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok && typeof body["error"] !== "string") {
    throw new OAuthFailure(transientOauth(`GitHub OAuth HTTP ${response.status}`));
  }
  return body;
}

function credentialFromTokenBody(
  task: SimulationTask,
  body: Record<string, unknown>,
  accountId: string,
): StoredCredential {
  const access = body["access_token"];
  if (typeof access !== "string") {
    throw new OAuthFailure(transientOauth("GitHub token response missing access_token"));
  }
  const refresh = typeof body["refresh_token"] === "string" ? body["refresh_token"] : "";
  const expiresIn =
    typeof body["expires_in"] === "number" ? body["expires_in"] : FALLBACK_ACCESS_TTL_S;
  return { access, refresh, accountId, expiresAt: task.wallNow() + expiresIn * 1000 };
}

export class GithubOAuthHttpClient implements GithubOAuthClient {
  private readonly config: GithubOAuthConfig;

  constructor(config: GithubOAuthConfig) {
    this.config = config;
  }

  private oauthUrl(path: string): string {
    return `${this.config.oauthBaseUrl ?? REAL_OAUTH_BASE_URL}${path}`;
  }

  /** Best-effort login lookup; an unnamed account never loses a credential. */
  private async fetchLogin(access: string): Promise<string> {
    try {
      const response = await fetch(`${this.config.apiBaseUrl ?? REAL_API_BASE_URL}/user`, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${access}`,
        },
      });
      if (!response.ok) return "unknown";
      const body = (await response.json()) as Record<string, unknown>;
      return typeof body["login"] === "string" ? body["login"] : "unknown";
    } catch {
      return "unknown";
    }
  }

  requestDeviceCode(
    task: SimulationTask,
  ): ResultAsync<GithubDeviceGrant, GithubOAuthTransientError> {
    const run = async (): Promise<GithubDeviceGrant> => {
      const body = await postForm(
        this.oauthUrl("/login/device/code"),
        new URLSearchParams({ client_id: this.config.clientId }),
      );
      const deviceCode = body["device_code"];
      const userCode = body["user_code"];
      const verificationUri = body["verification_uri"];
      if (
        typeof deviceCode !== "string" ||
        typeof userCode !== "string" ||
        typeof verificationUri !== "string"
      ) {
        throw new OAuthFailure(transientOauth("GitHub device-code response malformed"));
      }
      const intervalS = typeof body["interval"] === "number" ? body["interval"] : 5;
      const expiresInS = typeof body["expires_in"] === "number" ? body["expires_in"] : 900;
      return {
        deviceCode,
        userCode,
        verificationUri,
        intervalMs: intervalS * 1000,
        expiresAt: task.wallNow() + expiresInS * 1000,
      };
    };
    return ResultAsync.fromPromise(run(), (error) => {
      if (error instanceof OAuthFailure) return error.typed;
      return transientOauth(error instanceof Error ? error.message : String(error));
    });
  }

  pollDeviceToken(
    task: SimulationTask,
    deviceCode: string,
  ): ResultAsync<GithubPollOutcome, GithubOAuthTransientError> {
    const run = async (): Promise<GithubPollOutcome> => {
      const body = await postForm(
        this.oauthUrl("/login/oauth/access_token"),
        new URLSearchParams({
          client_id: this.config.clientId,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      );
      const errorCode = body["error"];
      if (typeof errorCode === "string") {
        if (errorCode === "authorization_pending") return { kind: "pending" };
        if (errorCode === "slow_down") return { kind: "slow_down" };
        if (errorCode === "expired_token") return { kind: "expired" };
        if (errorCode === "access_denied") return { kind: "denied" };
        throw new OAuthFailure(transientOauth(`GitHub device poll failed: ${errorCode}`));
      }
      const provisional = credentialFromTokenBody(task, body, "unknown");
      const login = await this.fetchLogin(provisional.access);
      return { kind: "authorized", credential: { ...provisional, accountId: login } };
    };
    return ResultAsync.fromPromise(run(), (error) => {
      if (error instanceof OAuthFailure) return error.typed;
      return transientOauth(error instanceof Error ? error.message : String(error));
    });
  }
}

const transientRefresh = (message: string, retryAfterMs?: number): UpstreamRefreshError => ({
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
 * The broker's upstream refresh for GitHub user tokens: the rotating
 * `refresh_token` grant, which for GitHub Apps requires the client secret.
 * `bad_refresh_token` maps to `invalid_grant`, clearing the credential and
 * re-opening the device ceremony.
 */
export class GithubUpstreamRefresher implements UpstreamRefresher {
  private readonly config: GithubOAuthConfig;

  constructor(config: GithubOAuthConfig) {
    this.config = config;
  }

  refresh(
    task: SimulationTask,
    credential: StoredCredential,
    context: OperationContext,
  ): ResultAsync<StoredCredential, UpstreamRefreshError> {
    const run = async (): Promise<StoredCredential> => {
      if (credential.refresh === "") {
        throw new RefreshFailure({
          type: "invalid_grant",
          message: "no GitHub refresh token stored (token expiration disabled?)",
        });
      }
      const body = await postForm(
        `${this.config.oauthBaseUrl ?? REAL_OAUTH_BASE_URL}/login/oauth/access_token`,
        new URLSearchParams({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          grant_type: "refresh_token",
          refresh_token: credential.refresh,
        }),
        context.signal,
      ).catch((error: unknown) => {
        if (error instanceof OAuthFailure)
          throw new RefreshFailure(transientRefresh(error.message));
        throw error;
      });
      const errorCode = body["error"];
      if (typeof errorCode === "string") {
        if (errorCode === "bad_refresh_token") {
          throw new RefreshFailure({
            type: "invalid_grant",
            message: String(body["error_description"] ?? errorCode),
          });
        }
        throw new RefreshFailure(transientRefresh(`GitHub refresh failed: ${errorCode}`));
      }
      return credentialFromTokenBody(task, body, credential.accountId);
    };
    return ResultAsync.fromPromise(run(), (error): UpstreamRefreshError => {
      if (error instanceof RefreshFailure) return error.typed;
      if (error instanceof OAuthFailure) return transientRefresh(error.message);
      return transientRefresh(error instanceof Error ? error.message : String(error));
    });
  }
}

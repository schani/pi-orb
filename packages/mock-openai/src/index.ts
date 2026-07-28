/**
 * E2E-mode provider override for the fake OpenAI service
 * (https://fake-openai.flingit.run). Overriding the `openai-codex` provider
 * with a custom `baseUrl` and `oauth` implementation is a supported Pi
 * injection point (PI-CODEX-E2E.md): Pi keeps its built-in Codex model
 * catalog, request serializer, and stream parser, while OAuth and inference
 * reach the mock. Production never registers this — it activates only when
 * both environment variables are set.
 *
 * Types are structural copies of the Pi surfaces we touch, so this package
 * has no dependency on the Pi SDK.
 */

export const MOCK_OPENAI_OAUTH_URL_ENV = "PI_ORB_FAKE_OPENAI_OAUTH_URL";
export const MOCK_OPENAI_INFERENCE_URL_ENV = "PI_ORB_FAKE_OPENAI_INFERENCE_URL";

export interface MockOpenAiConfig {
  /** Per-test-session OAuth base, e.g. https://…/oai/<sessionKey> */
  readonly oauthBaseUrl: string;
  /** Per-test-session inference base, e.g. https://…/oai/<sessionKey>/backend-api */
  readonly inferenceBaseUrl: string;
}

/** Read the E2E-mode configuration; null means production behavior. */
export function readMockOpenAiEnv(
  env: Record<string, string | undefined>,
): MockOpenAiConfig | null {
  const oauthBaseUrl = env[MOCK_OPENAI_OAUTH_URL_ENV];
  const inferenceBaseUrl = env[MOCK_OPENAI_INFERENCE_URL_ENV];
  if (
    oauthBaseUrl === undefined ||
    oauthBaseUrl === "" ||
    inferenceBaseUrl === undefined ||
    inferenceBaseUrl === ""
  ) {
    return null;
  }
  return { oauthBaseUrl, inferenceBaseUrl };
}

// -- structural copies of the Pi types this override plugs into -------------

export interface OAuthCredentialsShape {
  refresh: string;
  access: string;
  expires: number;
  [key: string]: unknown;
}

export interface OAuthLoginCallbacksShape {
  onAuth(info: { url: string; instructions?: string }): void;
  onDeviceCode(info: {
    userCode: string;
    verificationUri: string;
    intervalSeconds?: number;
    expiresInSeconds?: number;
  }): void;
  onProgress?(message: string): void;
  signal?: AbortSignal;
}

export interface MockProviderConfig {
  name: string;
  baseUrl: string;
  oauth: {
    name: string;
    login(callbacks: OAuthLoginCallbacksShape): Promise<OAuthCredentialsShape>;
    refreshToken(credentials: OAuthCredentialsShape): Promise<OAuthCredentialsShape>;
    getApiKey(credentials: OAuthCredentialsShape): string;
  };
}

// -- implementation ---------------------------------------------------------

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

// Pi's compat OAuth contract is promise-based and expects rejection on
// failure; this narrow boundary rejects instead of returning Results.
const fail = (message: string): Promise<never> => Promise.reject(new Error(message));

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(), ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("device login aborted"));
      },
      { once: true },
    );
  });

async function postJson(
  url: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
  if (signal !== undefined) init.signal = signal;
  const response = await fetch(url, init);
  const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, body: parsed };
}

async function exchangeToken(
  oauthBaseUrl: string,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<OAuthCredentialsShape> {
  const form = new URLSearchParams({ client_id: CLIENT_ID, ...params });
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  };
  if (signal !== undefined) init.signal = signal;
  const response = await fetch(`${oauthBaseUrl}/oauth/token`, init);
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const access = body["access_token"];
  const refresh = body["refresh_token"];
  const expiresIn = body["expires_in"];
  if (!response.ok || typeof access !== "string" || typeof refresh !== "string") {
    return fail(`mock token exchange failed (HTTP ${response.status}): ${JSON.stringify(body)}`);
  }
  return {
    access,
    refresh,
    expires: Date.now() + (typeof expiresIn === "number" ? expiresIn : 3600) * 1000,
  };
}

/**
 * The provider registration for `modelRuntime.registerProvider("openai-codex", …)`.
 * Implements the fake's device-code flow: usercode → poll → form-encoded
 * authorization-code exchange — the same wire shapes as Pi's built-in flow,
 * against the per-session mock origin.
 */
export function mockOpenAiProviderConfig(config: MockOpenAiConfig): MockProviderConfig {
  const { oauthBaseUrl, inferenceBaseUrl } = config;
  return {
    name: "OpenAI Codex (pi-orb E2E mock)",
    baseUrl: inferenceBaseUrl,
    oauth: {
      name: "Mock OpenAI Codex OAuth",

      async login(callbacks) {
        const started = await postJson(
          `${oauthBaseUrl}/api/accounts/deviceauth/usercode`,
          { client_id: CLIENT_ID },
          callbacks.signal,
        );
        const deviceAuthId = started.body["device_auth_id"];
        const userCode = started.body["user_code"];
        if (
          started.status !== 200 ||
          typeof deviceAuthId !== "string" ||
          typeof userCode !== "string"
        ) {
          return fail(`mock device authorization failed (HTTP ${started.status})`);
        }
        let intervalSeconds =
          typeof started.body["interval"] === "number" ? started.body["interval"] : 1;
        callbacks.onDeviceCode({
          userCode,
          verificationUri: `${oauthBaseUrl}/codex/device`,
          intervalSeconds,
          ...(typeof started.body["expires_in"] === "number"
            ? { expiresInSeconds: started.body["expires_in"] }
            : {}),
        });

        for (;;) {
          await sleep(intervalSeconds * 1000, callbacks.signal);
          const polled = await postJson(
            `${oauthBaseUrl}/api/accounts/deviceauth/token`,
            { device_auth_id: deviceAuthId, user_code: userCode },
            callbacks.signal,
          );
          if (polled.status === 200) {
            const code = polled.body["authorization_code"];
            const verifier = polled.body["code_verifier"];
            if (typeof code !== "string" || typeof verifier !== "string") {
              return fail("mock device poll returned an unexpected body");
            }
            return exchangeToken(
              oauthBaseUrl,
              { grant_type: "authorization_code", code, code_verifier: verifier },
              callbacks.signal,
            );
          }
          const error = (polled.body["error"] ?? {}) as Record<string, unknown>;
          const errorCode = typeof error["code"] === "string" ? error["code"] : "";
          if (polled.status === 403 && errorCode === "deviceauth_authorization_pending") {
            continue;
          }
          if (polled.status === 429 && errorCode === "slow_down") {
            intervalSeconds += 1;
            continue;
          }
          return fail(`mock device login failed (HTTP ${polled.status}): ${errorCode}`);
        }
      },

      refreshToken(credentials) {
        return exchangeToken(oauthBaseUrl, {
          grant_type: "refresh_token",
          refresh_token: credentials.refresh,
        });
      },

      getApiKey(credentials) {
        return credentials.access;
      },
    },
  };
}

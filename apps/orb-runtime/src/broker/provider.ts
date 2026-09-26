import type { SimulationTask } from "determined";
import type { BrokerTokenClient, BrokerTokenGrant } from "../domain/broker-client.ts";

/**
 * Pi provider config whose OAuth side is broker-backed (docs/credentials.md):
 * `login` fetches the first token, `refreshToken` fetches a newer one, and
 * the stored credential carries a synthetic refresh marker — the real
 * refresh token never exists in this process. Structural types match Pi's
 * `registerProvider` contract; failures travel as rejections because that is
 * the framework's contract for these callbacks.
 */

const BROKER_REFRESH_MARKER = "pi-orb-broker";

interface OAuthCredentialsShape {
  refresh: string;
  access: string;
  expires: number;
  [key: string]: unknown;
}

export interface BrokerProviderConfig {
  readonly name: string;
  readonly baseUrl?: string;
  getRequestDiagnostics(
    apiKey: string,
  ): { brokerGeneration?: number; tokenExpiresAt: number } | undefined;
  readonly oauth: {
    readonly name: string;
    login(callbacks?: unknown): Promise<OAuthCredentialsShape>;
    refreshToken(credentials: OAuthCredentialsShape): Promise<OAuthCredentialsShape>;
    getApiKey(credentials: OAuthCredentialsShape): string;
  };
}

function toPiCredentials(grant: BrokerTokenGrant): OAuthCredentialsShape {
  return {
    access: grant.accessToken,
    refresh: BROKER_REFRESH_MARKER,
    expires: grant.expiresAt,
    brokerGeneration: grant.generation,
  };
}

export function brokerProviderConfig(
  task: SimulationTask,
  client: BrokerTokenClient,
  options: { readonly inferenceBaseUrl?: string },
): BrokerProviderConfig {
  const grants = new Map<string, { brokerGeneration?: number; tokenExpiresAt: number } | null>();
  const bind = (credentials: OAuthCredentialsShape): void => {
    const { access, expires } = credentials;
    if (!Number.isSafeInteger(expires) || expires < 0) return;
    const generation = credentials["brokerGeneration"];
    const context = {
      tokenExpiresAt: expires,
      ...(typeof generation === "number" && Number.isSafeInteger(generation) && generation >= 0
        ? { brokerGeneration: generation }
        : {}),
    };
    const previous = grants.get(access);
    if (previous === null) return;
    if (
      previous &&
      (previous.brokerGeneration !== context.brokerGeneration ||
        previous.tokenExpiresAt !== context.tokenExpiresAt)
    ) {
      grants.set(access, null);
      return;
    }
    grants.set(access, context);
    if (grants.size > 32) grants.delete(grants.keys().next().value as string);
  };
  const fetchCredentials = async (
    reason: "startup" | "expiring",
  ): Promise<OAuthCredentialsShape> => {
    const outcome = await client.fetch(task, reason);
    if (outcome.isErr()) {
      return Promise.reject(new Error(`broker token fetch failed: ${outcome.error.type}`));
    }
    const credentials = toPiCredentials(outcome.value);
    bind(credentials);
    return credentials;
  };
  return {
    name: "OpenAI Codex (pi-orb broker)",
    getRequestDiagnostics: (apiKey) => grants.get(apiKey) ?? undefined,
    ...(options.inferenceBaseUrl !== undefined ? { baseUrl: options.inferenceBaseUrl } : {}),
    oauth: {
      name: "pi-orb broker",
      login: () => fetchCredentials("startup"),
      refreshToken: () => fetchCredentials("expiring"),
      getApiKey: (credentials) => {
        bind(credentials);
        return credentials.access;
      },
    },
  };
}

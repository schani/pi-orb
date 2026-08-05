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
  };
}

export function brokerProviderConfig(
  task: SimulationTask,
  client: BrokerTokenClient,
  options: { readonly inferenceBaseUrl?: string },
): BrokerProviderConfig {
  const fetchCredentials = async (
    reason: "startup" | "expiring",
  ): Promise<OAuthCredentialsShape> => {
    const outcome = await client.fetch(task, reason);
    if (outcome.isErr()) {
      return Promise.reject(new Error(`broker token fetch failed: ${outcome.error.type}`));
    }
    return toPiCredentials(outcome.value);
  };
  return {
    name: "OpenAI Codex (pi-orb broker)",
    ...(options.inferenceBaseUrl !== undefined ? { baseUrl: options.inferenceBaseUrl } : {}),
    oauth: {
      name: "pi-orb broker",
      login: () => fetchCredentials("startup"),
      refreshToken: () => fetchCredentials("expiring"),
      getApiKey: (credentials) => credentials.access,
    },
  };
}

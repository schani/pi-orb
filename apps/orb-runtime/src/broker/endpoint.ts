import {
  CONTROL_PLANE_URL_ENV,
  MODEL_TOKEN_PATH,
  ModelTokenResponseSchema,
  RUNTIME_TOKEN_ENV,
} from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { Check } from "typebox/value";
import type {
  BrokerEndpoint,
  BrokerEndpointResult,
  TokenRequestBody,
} from "../domain/broker-client.ts";

export interface BrokerEnv {
  readonly controlPlaneUrl: string;
  readonly runtimeToken: string;
}

/** Both variables are provider-delivered (DESIGN.md §15.1); one alone is a bug. */
export function readBrokerEnv(env: Record<string, string | undefined>): BrokerEnv | null {
  const controlPlaneUrl = env[CONTROL_PLANE_URL_ENV];
  const runtimeToken = env[RUNTIME_TOKEN_ENV];
  if (
    controlPlaneUrl === undefined ||
    controlPlaneUrl === "" ||
    runtimeToken === undefined ||
    runtimeToken === ""
  ) {
    return null;
  }
  return { controlPlaneUrl, runtimeToken };
}

/**
 * HTTP transport for the broker token client. Never throws: every outcome —
 * including network failure — maps to a typed `BrokerEndpointResult`.
 */
export class HttpBrokerEndpoint implements BrokerEndpoint {
  private readonly env: BrokerEnv;

  constructor(env: BrokerEnv) {
    this.env = env;
  }

  requestToken(_task: SimulationTask, body: TokenRequestBody): Promise<BrokerEndpointResult> {
    return fetch(`${this.env.controlPlaneUrl}${MODEL_TOKEN_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.env.runtimeToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }).then(
      async (response): Promise<BrokerEndpointResult> => {
        const payload: unknown = await response.json().catch(() => null);
        if (response.status === 200) {
          if (!Check(ModelTokenResponseSchema, payload)) {
            return { kind: "fatal", message: "malformed token response" };
          }
          return {
            kind: "grant",
            grant: {
              accessToken: payload.accessToken,
              accountId: payload.accountId,
              expiresAt: payload.expiresAt,
              generation: payload.generation,
            },
          };
        }
        if (response.status === 401) return { kind: "unauthorized" };
        if (response.status === 409) return { kind: "auth_required" };
        if (response.status === 429 || response.status >= 500) {
          const retryAfter = response.headers.get("retry-after");
          const retryAfterMs =
            retryAfter !== null && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : undefined;
          return {
            kind: "retryable",
            message: `broker HTTP ${response.status}`,
            ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
          };
        }
        return { kind: "fatal", message: `broker HTTP ${response.status}` };
      },
      (error: unknown): BrokerEndpointResult => ({
        kind: "retryable",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

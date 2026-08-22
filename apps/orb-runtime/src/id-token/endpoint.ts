import {
  ID_TOKEN_PATH,
  IdTokenErrorSchema,
  type IdTokenRequestBody,
  IdTokenResponseSchema,
} from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { Check } from "typebox/value";
import type { BrokerEnv } from "../broker/endpoint.ts";
import type { IdTokenEndpoint, IdTokenEndpointResult, IdTokenRequest } from "./token.ts";

/**
 * HTTP transport for the identity mint (docs/workload-identity.md). Like the
 * broker endpoint it never throws: every outcome, network failure included,
 * becomes a typed `IdTokenEndpointResult`. The incarnation bearer goes to the
 * control plane and nowhere else — never to the relying party the token is
 * minted for.
 */
export class HttpIdTokenEndpoint implements IdTokenEndpoint {
  private readonly env: BrokerEnv;

  constructor(env: BrokerEnv) {
    this.env = env;
  }

  mint(_task: SimulationTask, request: IdTokenRequest): Promise<IdTokenEndpointResult> {
    const body: IdTokenRequestBody = {
      audience: request.audience,
      ...(request.ttlSeconds === undefined ? {} : { ttlSeconds: request.ttlSeconds }),
    };
    return fetch(`${this.env.controlPlaneUrl}${ID_TOKEN_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.env.runtimeToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }).then(
      async (response): Promise<IdTokenEndpointResult> => {
        const payload: unknown = await response.json().catch(() => null);
        if (response.status === 200) {
          if (!Check(IdTokenResponseSchema, payload)) {
            return { kind: "internal", message: "malformed mint response" };
          }
          return { kind: "token", token: payload.token };
        }
        const headerRetryAfterMs = retryAfterMs(response.headers.get("retry-after"));
        if (!Check(IdTokenErrorSchema, payload)) {
          // A non-200 whose body is not the declared envelope: fall back to the
          // status, which is the only trustworthy signal left.
          return statusOnlyResult(response.status, headerRetryAfterMs);
        }
        const message = payload.message ?? `control plane HTTP ${response.status}`;
        switch (payload.error) {
          case "invalid_request":
            return { kind: "invalid_request", message };
          case "unauthorized":
            return { kind: "unauthorized" };
          case "not_mintable":
            return { kind: "not_mintable", message };
          case "internal":
            return { kind: "internal", message };
          case "rate_limited": {
            const delayMs = payload.retryAfterMs ?? headerRetryAfterMs;
            return {
              kind: "rate_limited",
              ...(delayMs === undefined ? {} : { retryAfterMs: delayMs }),
            };
          }
          case "retryable": {
            const delayMs = payload.retryAfterMs ?? headerRetryAfterMs;
            return {
              kind: "retryable",
              message,
              ...(delayMs === undefined ? {} : { retryAfterMs: delayMs }),
            };
          }
        }
      },
      // Connection refused, DNS failure, TLS failure: the control plane may be
      // restarting, so this is retryable rather than terminal.
      (error: unknown): IdTokenEndpointResult => ({
        kind: "retryable",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/** `Retry-After` in whole seconds (RFC 7231); a date form is ignored. */
function retryAfterMs(header: string | null): number | undefined {
  return header !== null && /^\d+$/.test(header) ? Number(header) * 1000 : undefined;
}

function statusOnlyResult(status: number, delayMs: number | undefined): IdTokenEndpointResult {
  const message = `control plane HTTP ${status}`;
  if (status === 400) return { kind: "invalid_request", message };
  if (status === 401) return { kind: "unauthorized" };
  if (status === 403) return { kind: "not_mintable", message };
  if (status === 429) {
    return { kind: "rate_limited", ...(delayMs === undefined ? {} : { retryAfterMs: delayMs }) };
  }
  if (status >= 500) {
    return {
      kind: "retryable",
      message,
      ...(delayMs === undefined ? {} : { retryAfterMs: delayMs }),
    };
  }
  return { kind: "internal", message };
}

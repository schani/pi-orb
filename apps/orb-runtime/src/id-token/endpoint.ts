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
 * Ceiling on one mint request, headers and body together. A control plane that
 * accepts the connection and then answers nothing — a half-dead instance, a
 * proxy holding the socket open — is indistinguishable from a working one to a
 * `fetch` without a deadline, and an executable credential source that hangs is
 * worse than one that fails: the SDK calling `pi-orb id-token` inherits the
 * hang. Three seconds is comfortably under `CLI_ID_TOKEN_CONSTANTS`'
 * whole-invocation budget of ten, so one silent attempt still leaves room for
 * the retry the client would make against a restarting control plane.
 */
export const MINT_REQUEST_TIMEOUT_MS = 3_000;

/**
 * HTTP transport for the identity mint (docs/workload-identity.md). Like the
 * broker endpoint it never throws: every outcome, network failure and timeout
 * included, becomes a typed `IdTokenEndpointResult`. The incarnation bearer
 * goes to the control plane and nowhere else — never to the relying party the
 * token is minted for.
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
    // One signal for the whole exchange: `fetch` ties the response body stream
    // to it too, so a control plane that sends a status line and then stalls
    // mid-body is bounded exactly like one that never replies at all.
    const deadline = AbortSignal.timeout(MINT_REQUEST_TIMEOUT_MS);
    return fetch(`${this.env.controlPlaneUrl}${ID_TOKEN_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.env.runtimeToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: deadline,
    }).then(
      async (response): Promise<IdTokenEndpointResult> => {
        let bodyFailed = false;
        const payload: unknown = await response.json().catch(() => {
          bodyFailed = true;
          return null;
        });
        // Distinguish "the body was unreadable because we aborted mid-stream"
        // from "the body was not JSON": calling the former malformed would
        // blame the control plane for a shape it never finished sending, and
        // hide a retryable stall behind a terminal `internal`. The check is on
        // the failed read rather than on the signal alone, so a response that
        // arrived complete is never thrown away by a deadline that fires while
        // it is being parsed.
        if (bodyFailed && deadline.aborted) return timedOut();
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
      // Connection refused, DNS failure, TLS failure, or our own deadline: the
      // control plane may be restarting, so this is retryable rather than
      // terminal.
      (error: unknown): IdTokenEndpointResult =>
        deadline.aborted
          ? timedOut()
          : {
              kind: "retryable",
              message: error instanceof Error ? error.message : String(error),
            },
    );
  }
}

/**
 * The deadline's own outcome, phrased so the CLI's stderr line names the
 * elapsed budget rather than repeating the platform's bare "operation was
 * aborted".
 */
function timedOut(): IdTokenEndpointResult {
  return {
    kind: "retryable",
    message: `control plane did not answer within ${MINT_REQUEST_TIMEOUT_MS}ms`,
  };
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

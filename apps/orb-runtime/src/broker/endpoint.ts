import {
  CONTROL_PLANE_URL_ENV,
  RUNTIME_TOKEN_ENV,
  runtimeTokenPath,
  TokenGrantSchema,
  type TokenName,
} from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { ResultAsync } from "neverthrow";
import { Check } from "typebox/value";
import type {
  BrokerEndpoint,
  BrokerEndpointResult,
  TokenRequestBody,
} from "../domain/broker-client.ts";
import { DEFAULT_BROKER_CLIENT_CONSTANTS } from "../domain/broker-client.ts";

export interface BrokerEnv {
  readonly controlPlaneUrl: string;
  readonly runtimeToken: string;
}

/** Both variables are provider-delivered (docs/credentials.md); one alone is a bug. */
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
  private readonly name: TokenName;

  constructor(env: BrokerEnv, name: TokenName) {
    this.env = env;
    this.name = name;
  }

  async requestToken(
    task: SimulationTask,
    body: TokenRequestBody,
    cancellation?: AbortSignal,
  ): Promise<BrokerEndpointResult> {
    const deadline = task.monotonicNow() + DEFAULT_BROKER_CLIENT_CONSTANTS.retryWindowMs;
    const budget = task.createDeadline(
      DEFAULT_BROKER_CLIENT_CONSTANTS.retryWindowMs,
      "broker HTTP request budget",
    );
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    cancellation?.addEventListener("abort", abort, { once: true });
    budget.signal.addEventListener("abort", abort, { once: true });
    if (cancellation?.aborted || budget.signal.aborted) abort();
    const signal = controller.signal;
    const expired = (): boolean => budget.signal.aborted || task.monotonicNow() >= deadline;
    const failed = (): BrokerEndpointResult =>
      cancellation?.aborted
        ? { kind: "cancelled" }
        : {
            kind: "retryable",
            message: expired() ? "broker HTTP request budget exhausted" : "broker transport failed",
          };
    try {
      const fetched = await ResultAsync.fromThrowable(
        async () =>
          fetch(`${this.env.controlPlaneUrl}${runtimeTokenPath(this.name)}`, {
            signal,
            method: "POST",
            headers: {
              authorization: `Bearer ${this.env.runtimeToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          }),
        failed,
      )();
      if (fetched.isErr()) return fetched.error;
      if (signal.aborted || expired()) {
        controller.abort();
        return failed();
      }
      const response = fetched.value;
      if (response.status !== 200) {
        // Status-only outcomes do not wait for a possibly stalled error body.
        const body = response.body;
        if (body) {
          const cancelled = await ResultAsync.fromThrowable(() => body.cancel(), failed)();
          if (cancelled.isErr()) return cancelled.error;
        }
        if (signal.aborted || expired()) return failed();
      }
      if (response.status === 200) {
        const parsed = await ResultAsync.fromThrowable(
          async (): Promise<unknown> => response.json(),
          (cause): BrokerEndpointResult =>
            cause instanceof SyntaxError
              ? { kind: "fatal", message: "malformed token response" }
              : failed(),
        )();
        if (signal.aborted || expired()) return failed();
        if (parsed.isErr()) return parsed.error;
        const payload = parsed.value;
        if (!Check(TokenGrantSchema, payload)) {
          return { kind: "fatal", message: "malformed token response" };
        }
        return {
          kind: "grant",
          grant: {
            accessToken: payload.accessToken,
            ...(payload.accountId !== undefined ? { accountId: payload.accountId } : {}),
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
    } finally {
      cancellation?.removeEventListener("abort", abort);
      budget.signal.removeEventListener("abort", abort);
      budget.cancel();
    }
  }
}

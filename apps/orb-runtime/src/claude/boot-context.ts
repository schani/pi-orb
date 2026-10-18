import {
  ORB_BOOT_CONTEXT_PATH,
  type OrbBootContextResponse,
  OrbBootContextResponseSchema,
} from "@pi-orb/protocol";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import { Check } from "typebox/value";
import type { BrokerEnv } from "../broker/endpoint.ts";

export const BOOT_CONTEXT_REQUEST_TIMEOUT_MS = 10_000;
export const BOOT_CONTEXT_BOOT_RETRY_WINDOW_MS = 180_000;
const BOOT_CONTEXT_RETRY_BASE_MS = 1_000;
const BOOT_CONTEXT_RETRY_CAP_MS = 4_000;

export interface BootContextError {
  readonly type: "boot_context_error";
  readonly message: string;
  readonly retryable: boolean;
}

export interface BootContextRetryOptions {
  readonly retryWindowMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const unavailable = (detail?: string): BootContextError => ({
  type: "boot_context_error",
  message:
    detail === undefined ? "boot context is unavailable" : `boot context is unavailable: ${detail}`,
  retryable: true,
});

function responseError(payload: unknown): { message: string; retryable: boolean } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const error = (payload as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  const typed = error as { message?: unknown; retryable?: unknown };
  return typeof typed.message === "string" && typeof typed.retryable === "boolean"
    ? { message: typed.message, retryable: typed.retryable }
    : null;
}

/** Immediate HTTP adapter: no thrown fetch, JSON, or schema failure crosses this boundary. */
function requestBootContext(env: BrokerEnv): ResultAsync<OrbBootContextResponse, BootContextError> {
  return ResultAsync.fromThrowable(
    async () => {
      const response = await fetch(`${env.controlPlaneUrl}${ORB_BOOT_CONTEXT_PATH}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.runtimeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ v: 1 }),
        signal: AbortSignal.timeout(BOOT_CONTEXT_REQUEST_TIMEOUT_MS),
      });
      const payload: unknown = await response.json();
      return { status: response.status, payload };
    },
    (cause) =>
      cause instanceof SyntaxError
        ? { ...unavailable("malformed response"), retryable: false }
        : unavailable(cause instanceof Error ? cause.message : String(cause)),
  )().andThen(({ status, payload }) => {
    if (status === 200 && Check(OrbBootContextResponseSchema, payload)) return ok(payload);
    const failure = responseError(payload);
    if (failure !== null)
      return err({
        type: "boot_context_error" as const,
        message: `boot context is unavailable: ${failure.message}`,
        retryable: failure.retryable,
      });
    return err({ ...unavailable("malformed response"), retryable: false });
  });
}

/** Mandatory boot read with a bounded, clock-injected retry window. */
export function fetchBootContext(
  env: BrokerEnv,
  options: BootContextRetryOptions = {},
): ResultAsync<OrbBootContextResponse, BootContextError> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (options.retryWindowMs ?? BOOT_CONTEXT_BOOT_RETRY_WINDOW_MS);

  const run = async (): Promise<Result<OrbBootContextResponse, BootContextError>> => {
    let delayMs = BOOT_CONTEXT_RETRY_BASE_MS;
    while (true) {
      const result = await requestBootContext(env);
      if (result.isOk() || !result.error.retryable || now() >= deadline) return result;

      await sleep(Math.min(delayMs, deadline - now()));
      if (now() >= deadline) return result;
      delayMs = Math.min(BOOT_CONTEXT_RETRY_CAP_MS, delayMs * 2);
    }
  };

  return new ResultAsync(run());
}

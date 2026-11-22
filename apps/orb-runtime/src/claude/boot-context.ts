import {
  ORB_BOOT_CONTEXT_PATH,
  ORB_PENDING_MODEL_ACK_PATH,
  type OrbBootContextResponse,
  OrbBootContextResponseSchema,
  OrbPendingModelAckResponseSchema,
} from "@pi-orb/protocol";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import type { Static, TSchema } from "typebox";
import { Check } from "typebox/value";
import type { BrokerEnv } from "../broker/endpoint.ts";

export const BOOT_CONTEXT_REQUEST_TIMEOUT_MS = 10_000;
export const BOOT_CONTEXT_BOOT_RETRY_WINDOW_MS = 180_000;
const BOOT_CONTEXT_RETRY_BASE_MS = 1_000;
const BOOT_CONTEXT_RETRY_CAP_MS = 4_000;

interface BootRequestError {
  readonly type: "boot_request_error";
  readonly message: string;
  readonly retryable: boolean;
}

export interface BootContextRetryOptions {
  readonly retryWindowMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

function responseError(payload: unknown): { message: string; retryable: boolean } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const error = (payload as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  const typed = error as { message?: unknown; retryable?: unknown };
  return typeof typed.message === "string" && typeof typed.retryable === "boolean"
    ? { message: typed.message, retryable: typed.retryable }
    : null;
}

function bootRequest<S extends TSchema>(
  env: BrokerEnv,
  path: string,
  body: object,
  schema: S,
  label: string,
): ResultAsync<Static<S>, BootRequestError> {
  const failure = (detail: string, retryable: boolean): BootRequestError => ({
    type: "boot_request_error",
    message: `${label}: ${detail}`,
    retryable,
  });
  return ResultAsync.fromThrowable(
    async () => {
      const response = await fetch(`${env.controlPlaneUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.runtimeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ v: 1, ...body }),
        signal: AbortSignal.timeout(BOOT_CONTEXT_REQUEST_TIMEOUT_MS),
      });
      const payload: unknown = await response.json();
      return { status: response.status, payload };
    },
    (cause) =>
      cause instanceof SyntaxError
        ? failure("malformed response", false)
        : failure("request failed", true),
  )().andThen(({ status, payload }) => {
    if (status === 200 && Check(schema, payload)) return ok(payload);
    const rejection = responseError(payload);
    return err(
      rejection
        ? failure(rejection.message, rejection.retryable)
        : failure("malformed response", false),
    );
  });
}

/** Mandatory boot read with a bounded, clock-injected retry window. */
export function fetchBootContext(
  env: BrokerEnv,
  options: BootContextRetryOptions = {},
): ResultAsync<OrbBootContextResponse, BootRequestError> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (options.retryWindowMs ?? BOOT_CONTEXT_BOOT_RETRY_WINDOW_MS);

  const run = async (): Promise<Result<OrbBootContextResponse, BootRequestError>> => {
    let delayMs = BOOT_CONTEXT_RETRY_BASE_MS;
    while (true) {
      const result = await bootRequest(
        env,
        ORB_BOOT_CONTEXT_PATH,
        {},
        OrbBootContextResponseSchema,
        "boot context is unavailable",
      );
      if (result.isOk() || !result.error.retryable || now() >= deadline) return result;

      await sleep(Math.min(delayMs, deadline - now()));
      if (now() >= deadline) return result;
      delayMs = Math.min(BOOT_CONTEXT_RETRY_CAP_MS, delayMs * 2);
    }
  };

  return new ResultAsync(run());
}

/** Do not retry an ambiguous ack; the next boot reads the authoritative choice again. */
export function acknowledgePendingModel(env: BrokerEnv, changeId: string) {
  return bootRequest(
    env,
    ORB_PENDING_MODEL_ACK_PATH,
    { changeId },
    OrbPendingModelAckResponseSchema,
    "Cannot acknowledge the queued Claude model",
  );
}

import {
  ORB_BOOT_CONTEXT_PATH,
  type OrbBootContextResponse,
  OrbBootContextResponseSchema,
} from "@pi-orb/protocol";
import { err, ok, ResultAsync } from "neverthrow";
import { Check } from "typebox/value";
import type { BrokerEnv } from "../broker/endpoint.ts";

export interface BootContextError {
  readonly type: "boot_context_error";
  readonly message: string;
  readonly retryable: boolean;
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
export function fetchBootContext(
  env: BrokerEnv,
): ResultAsync<OrbBootContextResponse, BootContextError> {
  return ResultAsync.fromThrowable(
    async () => {
      const response = await fetch(`${env.controlPlaneUrl}${ORB_BOOT_CONTEXT_PATH}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.runtimeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ v: 1 }),
        signal: AbortSignal.timeout(10_000),
      });
      const payload: unknown = await response.json();
      return { status: response.status, payload };
    },
    (cause) => unavailable(cause instanceof Error ? cause.message : String(cause)),
  )().andThen(({ status, payload }) => {
    if (status === 200 && Check(OrbBootContextResponseSchema, payload)) return ok(payload);
    const failure = responseError(payload);
    if (failure !== null)
      return err({
        type: "boot_context_error" as const,
        message: `boot context is unavailable: ${failure.message}`,
        retryable: failure.retryable,
      });
    return err(unavailable("malformed response"));
  });
}

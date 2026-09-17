import {
  ORB_SELF_SLEEP_PATH,
  type OrbSleepResponse,
  OrbSleepResponseSchema,
} from "@pi-orb/protocol";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import { Check } from "typebox/value";
import type { BrokerEnv } from "../broker/endpoint.ts";

export const SLEEP_USAGE = "usage: pi-orb sleep <positive integer><s|m|h|d>";

export interface SleepRequest {
  readonly durationSeconds: number;
}

export interface SleepFailure {
  readonly type: "sleep_failure";
  readonly code: string;
  readonly message: string;
}

const invalid = (): SleepFailure => ({
  type: "sleep_failure",
  code: "invalid_request",
  message: SLEEP_USAGE,
});

const secondsByUnit = { s: 1n, m: 60n, h: 3_600n, d: 86_400n } as const;
const MAX_DATE_DURATION_SECONDS = 8_640_000_000_000n;

function httpFailure(payload: unknown): { code: string; message: string } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const error = (payload as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  const typed = error as { code?: unknown; message?: unknown };
  return typeof typed.code === "string" && typeof typed.message === "string"
    ? { code: typed.code, message: typed.message }
    : null;
}

export function parseSleepArgs(args: readonly string[]): Result<SleepRequest, SleepFailure> {
  if (args.length !== 1) return err(invalid());
  const match = /^(\d+)([smhd])$/.exec(args[0] ?? "");
  if (match === null) return err(invalid());
  const unit = match[2] as keyof typeof secondsByUnit;
  const digits = (match[1] ?? "0").replace(/^0+/, "") || "0";
  if (digits.length > 13) return err(invalid());
  const seconds = BigInt(digits) * secondsByUnit[unit];
  if (
    seconds < 1n ||
    seconds > MAX_DATE_DURATION_SECONDS ||
    seconds > BigInt(Number.MAX_SAFE_INTEGER)
  )
    return err(invalid());
  return ok({ durationSeconds: Number(seconds) });
}

/** One bounded submission. A transport failure cannot reveal whether acceptance committed. */
export function requestSelfSleep(
  env: BrokerEnv,
  request: SleepRequest,
): ResultAsync<OrbSleepResponse, SleepFailure> {
  const unknown = (): SleepFailure => ({
    type: "sleep_failure",
    code: "unknown_outcome",
    message: "sleep acceptance is unknown; inspect this orb's status before trying again",
  });
  return ResultAsync.fromThrowable(async () => {
    const response = await fetch(`${env.controlPlaneUrl}${ORB_SELF_SLEEP_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.runtimeToken}`, "content-type": "application/json" },
      body: JSON.stringify({ v: 1, durationSeconds: request.durationSeconds }),
      signal: AbortSignal.timeout(3_000),
    });
    const payload: unknown = await response.json();
    return { status: response.status, payload };
  }, unknown)().andThen(({ status, payload }) => {
    if (status === 202 && Check(OrbSleepResponseSchema, payload)) return ok(payload);
    const failure = httpFailure(payload);
    if (status !== 202 && failure !== null)
      return err({ type: "sleep_failure" as const, ...failure });
    return err(unknown());
  });
}

export function sleepExitCode(failure: SleepFailure): number {
  if (failure.code === "invalid_request") return 2;
  if (failure.code === "unauthorized") return 3;
  if (failure.code === "conflict" || failure.code === "not_found") return 4;
  if (failure.code === "internal") return 7;
  return 6;
}

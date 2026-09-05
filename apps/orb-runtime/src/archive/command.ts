import {
  ORB_SELF_ARCHIVE_PATH,
  OrbArchiveErrorSchema,
  type OrbArchiveResponse,
  OrbArchiveResponseSchema,
} from "@pi-orb/protocol";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import { Check } from "typebox/value";
import type { BrokerEnv } from "../broker/endpoint.ts";

export const ARCHIVE_USAGE = "usage: pi-orb archive";
export type ArchiveFailure = {
  readonly type: "archive_failure";
  readonly code:
    | "invalid_request"
    | "unauthorized"
    | "not_found"
    | "conflict"
    | "unavailable"
    | "internal"
    | "unknown_outcome";
  readonly message: string;
};
export function parseArchiveArgs(args: readonly string[]): Result<void, ArchiveFailure> {
  return args.length === 0
    ? ok(undefined)
    : err({ type: "archive_failure", code: "invalid_request", message: ARCHIVE_USAGE });
}

/** A transport failure after submission cannot establish whether intent committed. */
export function requestSelfArchive(
  env: BrokerEnv,
): ResultAsync<OrbArchiveResponse, ArchiveFailure> {
  const unknown = (): ArchiveFailure => ({
    type: "archive_failure",
    code: "unknown_outcome",
    message: "archive acceptance is unknown; inspect this orb's state or retry pi-orb archive",
  });
  return ResultAsync.fromThrowable(async () => {
    const response = await fetch(`${env.controlPlaneUrl}${ORB_SELF_ARCHIVE_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.runtimeToken}`, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(3_000),
    });
    const payload: unknown = await response.json();
    return { status: response.status, payload };
  }, unknown)().andThen(({ status, payload }) => {
    if (status === 202 && Check(OrbArchiveResponseSchema, payload)) return ok(payload);
    if (status !== 202 && Check(OrbArchiveErrorSchema, payload)) {
      return err({
        type: "archive_failure" as const,
        code: payload.error.code,
        message: payload.error.message,
      });
    }
    return err(unknown());
  });
}

export function archiveExitCode(failure: ArchiveFailure): number {
  switch (failure.code) {
    case "invalid_request":
      return 2;
    case "unauthorized":
      return 3;
    case "not_found":
    case "conflict":
      return 4;
    case "unavailable":
    case "unknown_outcome":
      return 6;
    case "internal":
      return 7;
  }
}

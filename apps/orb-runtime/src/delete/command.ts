import {
  ORB_SELF_DELETE_PATH,
  ORB_SPAWN_UUID,
  OrbDeleteErrorSchema,
  type OrbDeleteRequest,
  type OrbDeleteResponse,
  OrbDeleteResponseSchema,
} from "@pi-orb/protocol";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import { Check } from "typebox/value";
import type { BrokerEnv } from "../broker/endpoint.ts";

export const DELETE_USAGE = "usage: pi-orb delete <self|orb-id>";
export type DeleteFailure = {
  readonly type: "delete_failure";
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
export function parseDeleteArgs(args: readonly string[]): Result<OrbDeleteRequest, DeleteFailure> {
  const [target] = args;
  if (args.length === 1 && target === "self") return ok({ self: true });
  if (args.length === 1 && target !== undefined && ORB_SPAWN_UUID.test(target))
    return ok({ orbId: target.toLowerCase() });
  return err({ type: "delete_failure", code: "invalid_request", message: DELETE_USAGE });
}

/** A transport failure after submission cannot establish whether intent committed. */
export function requestDelete(
  env: BrokerEnv,
  target: OrbDeleteRequest,
): ResultAsync<OrbDeleteResponse, DeleteFailure> {
  const targetLabel = "self" in target ? "this orb" : `orb ${target.orbId}`;
  const unknown = (): DeleteFailure => ({
    type: "delete_failure",
    code: "unknown_outcome",
    message: `deletion acceptance is unknown; inspect ${targetLabel} in the dashboard`,
  });
  return ResultAsync.fromThrowable(async () => {
    const response = await fetch(`${env.controlPlaneUrl}${ORB_SELF_DELETE_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.runtimeToken}`, "content-type": "application/json" },
      body: JSON.stringify(target),
      signal: AbortSignal.timeout(3_000),
    });
    const payload: unknown = await response.json();
    return { status: response.status, payload };
  }, unknown)().andThen(({ status, payload }) => {
    if (status === 202 && Check(OrbDeleteResponseSchema, payload)) return ok(payload);
    if (status !== 202 && Check(OrbDeleteErrorSchema, payload)) {
      return err({
        type: "delete_failure" as const,
        code: payload.error.code,
        message: payload.error.message,
      });
    }
    return err(unknown());
  });
}

export function deleteExitCode(failure: DeleteFailure): number {
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

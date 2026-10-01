import { randomUUID } from "node:crypto";
import {
  ALERT_MAX_LENGTH,
  RUNTIME_ALERT_PATH,
  type RuntimeAlertResponse,
  RuntimeAlertResponseSchema,
} from "@pi-orb/protocol";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import { Check } from "typebox/value";

export const ALERT_USAGE = 'usage: pi-orb alert "message" [--request-id <id>]';
export type AlertError = {
  readonly code: "invalid_request" | "rejected" | "unknown_outcome";
  readonly message: string;
  readonly requestId?: string;
};
export interface AlertInput {
  readonly message: string;
  readonly requestId: string;
}

export function parseAlertArgs(args: string[]): Result<AlertInput, AlertError> {
  const valid =
    (args.length === 1 || (args.length === 3 && args[1] === "--request-id")) &&
    typeof args[0] === "string" &&
    args[0].trim().length > 0 &&
    args[0].length <= ALERT_MAX_LENGTH &&
    (args.length === 1 || (args[2] !== undefined && args[2].length > 0 && args[2].length <= 128));
  if (!valid || args[0] === undefined)
    return err({ code: "invalid_request", message: ALERT_USAGE });
  return ok({ message: args[0], requestId: args[2] ?? randomUUID() });
}

export function sendAlert(
  input: AlertInput,
  options: { token: string; port: number; fetch?: typeof fetch },
): ResultAsync<RuntimeAlertResponse, AlertError> {
  return ResultAsync.fromPromise(
    Promise.resolve()
      .then(() =>
        (options.fetch ?? fetch)(`http://127.0.0.1:${options.port}${RUNTIME_ALERT_PATH}`, {
          method: "POST",
          headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
          body: JSON.stringify({ v: 1, ...input }),
          signal: AbortSignal.timeout(10_000),
        }),
      )
      .then(async (response) => ({
        status: response.status,
        body: (await response.json()) as unknown,
      })),
    (): AlertError => ({
      code: "unknown_outcome",
      message: `Alert outcome unknown. Retry with --request-id ${input.requestId}.`,
      requestId: input.requestId,
    }),
  ).andThen(({ status, body }) => {
    if (status === 200 && Check(RuntimeAlertResponseSchema, body)) return ok(body);
    if (status >= 400 && status < 500)
      return err({ code: "rejected" as const, message: `Alert rejected (HTTP ${status}).` });
    return err({
      code: "unknown_outcome" as const,
      message: `Alert outcome unknown (HTTP ${status}). Retry with --request-id ${input.requestId}.`,
      requestId: input.requestId,
    });
  });
}

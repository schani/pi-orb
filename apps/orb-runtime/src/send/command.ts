import { randomUUID } from "node:crypto";
import {
  ORB_SEND_MAX_BYTES,
  ORB_SEND_PATH,
  ORB_SPAWN_UUID,
  type OrbSendResponse,
  OrbSendResponseSchema,
} from "@pi-orb/protocol";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import { Check } from "typebox/value";

export const SEND_USAGE = 'usage: pi-orb send <orb-id> "message" [--request-id <id>]';
export interface SendInput {
  readonly orbId: string;
  readonly message: string;
  readonly requestId: string;
}
export interface SendError {
  readonly code: "invalid_request" | "rejected" | "unknown_outcome";
  readonly message: string;
  readonly requestId?: string;
}
export function parseSendArgs(args: string[]): Result<SendInput, SendError> {
  const [orbId, message, flag, requestId] = args;
  if (
    (args.length !== 2 && args.length !== 4) ||
    !orbId ||
    !ORB_SPAWN_UUID.test(orbId) ||
    !message?.trim() ||
    Buffer.byteLength(message) > ORB_SEND_MAX_BYTES ||
    (args.length === 4 && (flag !== "--request-id" || !requestId || requestId.length > 128))
  )
    return err({ code: "invalid_request", message: SEND_USAGE });
  return ok({ orbId: orbId.toLowerCase(), message, requestId: requestId ?? randomUUID() });
}
export function sendMessage(
  input: SendInput,
  options: {
    baseUrl: string;
    token: string;
    fetch?: typeof fetch;
  },
): ResultAsync<OrbSendResponse, SendError> {
  const unknown = (): SendError => ({
    code: "unknown_outcome",
    requestId: input.requestId,
    message: `Message acceptance unknown. Retry with --request-id ${input.requestId}.`,
  });
  return ResultAsync.fromThrowable(async () => {
    const response = await (options.fetch ?? fetch)(
      `${options.baseUrl.replace(/\/$/u, "")}${ORB_SEND_PATH}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
        body: JSON.stringify({ v: 1, ...input }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const body: unknown = await response.json();
    return { status: response.status, body };
  }, unknown)().andThen(({ status, body }) => {
    if (
      status === 202 &&
      Check(OrbSendResponseSchema, body) &&
      body.orbId === input.orbId &&
      body.requestId === input.requestId
    )
      return ok(body);
    if (status >= 400 && status < 500)
      return err({
        code: "rejected" as const,
        message: `Message rejected (HTTP ${status}).`,
        requestId: input.requestId,
      });
    return err(unknown());
  });
}

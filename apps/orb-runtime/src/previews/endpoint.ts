import type { PreviewError, PreviewRegistration } from "@pi-orb/protocol";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import type { BrokerEnv } from "../broker/endpoint.ts";
import type { PreviewCommand } from "./command.ts";
export type PreviewResponse =
  | { preview: PreviewRegistration }
  | { previews: readonly PreviewRegistration[] }
  | { revoked: true };
const failure = (message: string): PreviewError => ({
  type: "preview_error",
  code: "upstream_failed",
  message,
});
function registration(value: unknown): value is PreviewRegistration {
  return (
    typeof value === "object" &&
    value !== null &&
    "port" in value &&
    typeof value.port === "number" &&
    Number.isInteger(value.port) &&
    value.port > 0 &&
    value.port <= 65535 &&
    "registrationId" in value &&
    typeof value.registrationId === "string" &&
    value.registrationId.length > 0 &&
    "url" in value &&
    typeof value.url === "string" &&
    /^https?:\/\//.test(value.url)
  );
}
export async function requestPreviews(
  env: BrokerEnv,
  command: PreviewCommand,
): Promise<Result<PreviewResponse, PreviewError>> {
  const path = `/runtime/previews${command.type === "previews" ? "" : `/${command.port}`}`;
  const response = await ResultAsync.fromThrowable(
    () =>
      fetch(`${env.controlPlaneUrl}${path}`, {
        method: command.type === "expose" ? "PUT" : command.type === "unexpose" ? "DELETE" : "GET",
        headers: { authorization: `Bearer ${env.runtimeToken}` },
        signal: AbortSignal.timeout(5_000),
      }),
    () => failure("Preview registration request failed"),
  )();
  if (response.isErr()) return err(response.error);
  if (command.type === "unexpose" && response.value.status === 204) return ok({ revoked: true });
  const payload = await ResultAsync.fromThrowable(
    () => response.value.json() as Promise<unknown>,
    () => failure("Malformed preview response"),
  )();
  if (payload.isErr()) return err(payload.error);
  const value = payload.value;
  if (!response.value.ok) {
    const message =
      typeof value === "object" &&
      value !== null &&
      "error" in value &&
      typeof value.error === "object" &&
      value.error !== null &&
      "message" in value.error &&
      typeof value.error.message === "string"
        ? value.error.message
        : `Preview registration HTTP ${response.value.status}`;
    return err(failure(message));
  }
  if (typeof value === "object" && value !== null) {
    if (
      command.type === "expose" &&
      "preview" in value &&
      registration(value.preview) &&
      value.preview.port === command.port
    )
      return ok({ preview: value.preview });
    if (
      command.type === "previews" &&
      "previews" in value &&
      Array.isArray(value.previews) &&
      value.previews.every(registration)
    )
      return ok({ previews: value.previews });
  }
  return err(failure("Malformed preview response"));
}

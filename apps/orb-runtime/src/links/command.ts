import { ORB_LINKS_RUNTIME_PATH } from "@pi-orb/protocol";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import type { BrokerEnv } from "../broker/endpoint.ts";

export const LINK_USAGE = "usage: pi-orb link <github-url>";

export function parseLinkArgs(args: readonly string[]): Result<string, string> {
  return args.length === 1 && args[0] ? ok(args[0]) : err(LINK_USAGE);
}

/** Saves the link and returns its canonical URL, or a message. */
export async function requestLink(
  env: BrokerEnv,
  url: string,
  fetcher: typeof fetch = fetch,
): Promise<Result<string, string>> {
  return ResultAsync.fromThrowable(
    async () => {
      const response = await fetcher(`${env.controlPlaneUrl}${ORB_LINKS_RUNTIME_PATH}`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${env.runtimeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(10_000),
      });
      return { status: response.status, body: (await response.json()) as unknown };
    },
    () => "link request failed",
  )().andThen(({ status, body }) => {
    const value = typeof body === "object" && body !== null ? body : {};
    if (status === 200 && "url" in value && typeof value.url === "string") return ok(value.url);
    const error = "error" in value && typeof value.error === "object" ? value.error : null;
    return err(
      error !== null && "message" in error && typeof error.message === "string"
        ? error.message
        : `link request HTTP ${status}`,
    );
  });
}

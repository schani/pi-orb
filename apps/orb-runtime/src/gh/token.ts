import type { SimulationTask } from "determined";
import { err, ok, type Result } from "neverthrow";
import {
  type BrokerClientConstants,
  type BrokerClientError,
  type BrokerEndpoint,
  BrokerTokenClient,
} from "../domain/broker-client.ts";

/**
 * Point-of-use GitHub token logic (docs/credentials.md) shared by the `gh` shim
 * and the git credential helper. Each invocation fetches a fresh short-lived
 * token from the broker; nothing is persisted — no hosts.yml, no cached
 * token on disk.
 */

/** A CLI invocation must answer fast: much tighter than the runtime's boot windows. */
const CLI_CONSTANTS: BrokerClientConstants = {
  bootRetryWindowMs: 10_000,
  retryWindowMs: 10_000,
  backoffBaseMs: 250,
  backoffCapMs: 2_000,
};

/** Parse git's credential-helper key=value request lines. */
export function parseCredentialRequest(input: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const line of input.split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    if (attrs[key] === undefined) attrs[key] = line.slice(separator + 1);
  }
  return attrs;
}

/** Only https to github.com gets a credential; everything else stays silent. */
export function shouldServeCredential(attrs: Record<string, string>): boolean {
  return attrs["protocol"] === "https" && attrs["host"] === "github.com";
}

/** The credential-helper response for a GitHub App user token. */
export function credentialOutput(token: string): string {
  return `username=x-access-token\npassword=${token}\n`;
}

export function describeTokenFailure(error: BrokerClientError): string {
  switch (error.type) {
    case "auth_required":
      return "GitHub is not connected: start an orb and complete the GitHub device login.";
    case "unauthorized":
      return "the control plane rejected this orb token (is the orb still running?)";
    case "unavailable":
      return `credential broker unavailable: ${error.message}`;
    case "fatal":
      return `credential broker error: ${error.message}`;
  }
}

export async function fetchGithubToken(
  task: SimulationTask,
  endpoint: BrokerEndpoint,
): Promise<Result<string, string>> {
  const client = new BrokerTokenClient(endpoint, CLI_CONSTANTS);
  const outcome = await client.fetch(task, "startup");
  if (outcome.isErr()) return err(describeTokenFailure(outcome.error));
  return ok(outcome.value.accessToken);
}

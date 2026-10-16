import type { AccountInfo } from "@anthropic-ai/claude-agent-sdk";
import { runtimeClaudeSubscriptionPath } from "@pi-orb/protocol";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import type { BrokerEnv } from "../broker/endpoint.ts";

export interface ClaudeAuthError {
  readonly code: "claude_auth_required" | "claude_auth_unavailable";
  readonly message: string;
  readonly retryable: boolean;
}
export interface ClaudeSubscription {
  readonly token: string;
  readonly generation: number;
}

export function verifyClaudeAccount(account: AccountInfo): Result<void, ClaudeAuthError> {
  return account.apiProvider === "firstParty" &&
    (account.apiKeySource === undefined || account.apiKeySource === "none") &&
    account.tokenSource === "CLAUDE_CODE_OAUTH_TOKEN"
    ? ok(undefined)
    : err({
        code: "claude_auth_required",
        message:
          "Claude did not select the configured subscription credential; inference is blocked.",
        retryable: false,
      });
}

export function fetchClaudeSubscription(
  broker: BrokerEnv,
  request: typeof fetch = fetch,
): ResultAsync<ClaudeSubscription, ClaudeAuthError> {
  return ResultAsync.fromThrowable(
    async () => {
      const response = await request(`${broker.controlPlaneUrl}${runtimeClaudeSubscriptionPath}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${broker.runtimeToken}`,
          "content-type": "application/json",
        },
        body: "{}",
      });
      if (!response.ok)
        return err<ClaudeSubscription, ClaudeAuthError>({
          code:
            response.status === 409 || response.status === 401
              ? "claude_auth_required"
              : "claude_auth_unavailable",
          message: `Claude subscription credential unavailable (HTTP ${response.status}).`,
          retryable: response.status >= 500 || response.status === 429,
        });
      const value: unknown = await response.json();
      if (
        value === null ||
        typeof value !== "object" ||
        !("token" in value) ||
        typeof value.token !== "string" ||
        value.token.trim() === "" ||
        !("generation" in value) ||
        typeof value.generation !== "number" ||
        !Number.isSafeInteger(value.generation) ||
        value.generation < 0
      )
        return err<ClaudeSubscription, ClaudeAuthError>({
          code: "claude_auth_unavailable",
          message: "Malformed Claude credential response.",
          retryable: false,
        });
      return ok<ClaudeSubscription, ClaudeAuthError>({
        token: value.token,
        generation: value.generation,
      });
    },
    (): ClaudeAuthError => ({
      code: "claude_auth_unavailable",
      message: "Cannot fetch Claude subscription credential.",
      retryable: true,
    }),
  )().andThen((value) => value);
}

/**
 * Variables that can replace the subscription credential, directly or via shell
 * startup files (`BASH_ENV`, `ENV`). Cloud credentials (`AWS_*`,
 * `GOOGLE_APPLICATION_CREDENTIALS`) select nothing without `CLAUDE_CODE_USE_*`,
 * so they stay available to the agent's tools.
 */
export const CLAUDE_AUTH_ENV = /^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR$|BASH_ENV$|ENV$)/;

/** Only the supervised SDK subprocess gets this bearer. No gateway/API fallback. */
export function claudeChildEnvironment(
  base: Readonly<NodeJS.ProcessEnv>,
  token: string,
  configDir: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (CLAUDE_AUTH_ENV.test(name)) continue;
    env[name] = value;
  }
  env.CLAUDE_CODE_OAUTH_TOKEN = token;
  env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}

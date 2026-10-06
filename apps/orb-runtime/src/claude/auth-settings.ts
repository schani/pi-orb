import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok, Result } from "neverthrow";
import type { ClaudeAuthError } from "./auth.ts";

/** Native settings remain enabled, but cannot replace the owner-selected billing credential. */
export function validateClaudeAuthSettings(
  cwd: string,
  configDir: string,
): Result<void, ClaudeAuthError> {
  for (const path of [
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
    join(configDir, "settings.json"),
  ]) {
    const loaded = Result.fromThrowable(
      (): unknown => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}),
      (): ClaudeAuthError => ({
        code: "claude_auth_required",
        message: "Cannot validate native Claude authentication settings.",
        retryable: false,
      }),
    )();
    if (loaded.isErr()) return err(loaded.error);
    const settings = loaded.value;
    if (settings === null || typeof settings !== "object" || Array.isArray(settings))
      return err({
        code: "claude_auth_required",
        message: "Malformed native Claude settings.",
        retryable: false,
      });
    const env = "env" in settings ? settings.env : null;
    const overrides =
      env !== null &&
      typeof env === "object" &&
      Object.keys(env).some((name) =>
        /^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR$|AWS_|GOOGLE_APPLICATION_CREDENTIALS$|CLOUD_ML_|BASH_ENV$|ENV$)/.test(
          name,
        ),
      );
    if (overrides || ("apiKeyHelper" in settings && settings.apiKeyHelper !== ""))
      return err({
        code: "claude_auth_required",
        message:
          "Native Claude settings override authentication. Remove auth helpers/provider environment settings before using the subscription harness.",
        retryable: false,
      });
  }
  return ok(undefined);
}

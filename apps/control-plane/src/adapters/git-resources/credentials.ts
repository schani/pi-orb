import { errAsync, ok, Result, type ResultAsync } from "neverthrow";
import { type ResourceError, resourceError } from "../../domain/resources.ts";
import type { GitCredentials } from "./git.ts";

/** Composition resolves the orb's project owner through the existing broker service. */
export type GitTokenProvider = (
  orbId: string,
  signal: AbortSignal,
) => ResultAsync<string | null, ResourceError>;
export function authenticatedGitCredentials(token: GitTokenProvider): GitCredentials {
  return {
    environment: (url, signal, orbId) => {
      const parsed = Result.fromThrowable(
        () => new URL(url),
        () => resourceError("invalid", "Invalid Git repository URL"),
      )();
      if (parsed.isErr()) return errAsync(parsed.error);
      const u = parsed.value;
      if (
        u.protocol !== "https:" ||
        u.hostname !== "github.com" ||
        u.port ||
        u.username ||
        u.password ||
        u.search ||
        u.hash ||
        !/^\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/?$/.test(u.pathname)
      )
        return errAsync(
          resourceError("authentication", "Unsupported authenticated Git repository URL"),
        );
      if (signal.aborted)
        return errAsync(resourceError("cancelled", "Git credential request cancelled"));
      return token(orbId, signal)
        .mapErr((error) =>
          resourceError(
            error.code === "cancelled" ? "cancelled" : "authentication",
            "Git credential unavailable",
          ),
        )
        .andThen((accessToken) => {
          if (signal.aborted)
            return errAsync(resourceError("cancelled", "Git credential request cancelled"));
          if (accessToken === null)
            return ok({
              GIT_CONFIG_COUNT: "2",
              GIT_CONFIG_KEY_0: "http.followRedirects",
              GIT_CONFIG_VALUE_0: "false",
              GIT_CONFIG_KEY_1: "credential.helper",
              GIT_CONFIG_VALUE_1: "",
              GIT_TERMINAL_PROMPT: "0",
            } satisfies Record<string, string>);
          if (!accessToken || /[\r\n\0]/.test(accessToken))
            return errAsync(resourceError("authentication", "Git credential unavailable"));
          return ok({
            GIT_CONFIG_COUNT: "3",
            GIT_CONFIG_KEY_0: "http.followRedirects",
            GIT_CONFIG_VALUE_0: "false",
            GIT_CONFIG_KEY_1: "http.https://github.com/.extraHeader",
            GIT_CONFIG_VALUE_1: `Authorization: Basic ${Buffer.from(`x-access-token:${accessToken}`).toString("base64")}`,
            GIT_CONFIG_KEY_2: "credential.helper",
            GIT_CONFIG_VALUE_2: "",
            GIT_TERMINAL_PROMPT: "0",
          } satisfies Record<string, string>);
        });
    },
  };
}

import { pathToFileURL } from "node:url";
import type { GitCredentials } from "../../apps/control-plane/src/adapters/git-resources/git.ts";

/** Resolve production credentials unchanged; only redirect test Git transport to its own repository. */
export function localOwnedGitCredentials(
  credentials: GitCredentials,
  repository: string,
  observe: (orbId: string, environment: Record<string, string>) => void,
): GitCredentials {
  return {
    environment: (url, signal, orbId) =>
      credentials.environment(url, signal, orbId).map((environment) => {
        observe(orbId, environment);
        const index = Number(environment.GIT_CONFIG_COUNT ?? "0");
        return {
          ...environment,
          GIT_CONFIG_COUNT: String(index + 2),
          [`GIT_CONFIG_KEY_${index}`]: `url.${pathToFileURL(repository).href}.insteadOf`,
          [`GIT_CONFIG_VALUE_${index}`]: url,
          [`GIT_CONFIG_KEY_${index + 1}`]: "protocol.file.allow",
          [`GIT_CONFIG_VALUE_${index + 1}`]: "always",
        };
      }),
  };
}

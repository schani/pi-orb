import { pathToFileURL } from "node:url";
import { err, ok, type ResultAsync } from "neverthrow";
import {
  type ResourceError,
  type ResourceSnapshot,
  type ResourceSource,
  resourceError,
} from "../../apps/control-plane/src/domain/resources.ts";

export const CROSS_AXIS_CASES = [
  { provider: "process", agentBackend: "central-durable", movingMain: true },
  { provider: "process", agentBackend: "host-pi", movingMain: false },
  { provider: "docker", agentBackend: "central-durable", movingMain: false },
] as const;

export function localGitEnvironment(repository: string, url: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: `url.${pathToFileURL(repository).href}.insteadOf`,
    GIT_CONFIG_VALUE_0: url,
    GIT_CONFIG_KEY_1: "protocol.file.allow",
    GIT_CONFIG_VALUE_1: "always",
  };
}

export function issuedDeviceLoginChallenge(
  action: { type?: string; userCode?: string } | undefined,
): { type?: string; userCode: string } | null {
  return action?.type === "openai_codex_device_login" && action.userCode
    ? { ...action, userCode: action.userCode }
    : null;
}

/** Hold the immutable result, not main's resolution; production persists it after release. */
export function afterAcquireGate(
  source: ResourceSource,
  gate: (snapshot: ResourceSnapshot, signal: AbortSignal) => ResultAsync<unknown, ResourceError>,
): ResourceSource {
  return {
    acquire: (input) =>
      source
        .acquire(input)
        .andThen((snapshot) =>
          gate(snapshot, input.signal).andThen(() =>
            input.signal.aborted
              ? err(resourceError("cancelled", "Fixture acquisition cancelled"))
              : ok(snapshot),
          ),
        ),
  };
}

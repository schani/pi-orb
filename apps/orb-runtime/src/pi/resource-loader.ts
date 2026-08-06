import {
  DefaultResourceLoader,
  type ResourceLoader,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Result, ResultAsync } from "neverthrow";
import { portExposurePrompt } from "../tailscale/prompt.ts";

type LoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];

export interface PortExposureLoaderInput {
  readonly cwd: string;
  readonly agentDir: string;
  /** Shared with `createAgentSession`; omitted where the SDK default is used. */
  readonly settingsManager?: SettingsManager | undefined;
  readonly previewHost: string;
}

/**
 * Mirrors what `createAgentSession` builds when no `resourceLoader` is passed
 * (`new DefaultResourceLoader({ cwd, agentDir, settingsManager })` followed by
 * `reload()`), so supplying one loses none of the implicit behavior — AGENTS.md
 * context files, skills, prompts, themes, extensions all still load.
 *
 * The prompt is appended through `appendSystemPromptOverride`, not
 * `appendSystemPrompt`: the latter *replaces* the loader's discovery of
 * `APPEND_SYSTEM.md`, while the override runs on top of whatever was
 * discovered.
 */
export function portExposureLoaderOptions(input: PortExposureLoaderInput): LoaderOptions {
  return {
    cwd: input.cwd,
    agentDir: input.agentDir,
    ...(input.settingsManager !== undefined ? { settingsManager: input.settingsManager } : {}),
    appendSystemPromptOverride: (base: string[]): string[] => [
      ...base,
      portExposurePrompt(input.previewHost),
    ],
  };
}

/** Never rejects: a loader that cannot be built leaves the session unchanged. */
export function createPortExposureLoader(
  input: PortExposureLoaderInput,
): ResultAsync<ResourceLoader, string> {
  const toMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);
  return Result.fromThrowable(
    () => new DefaultResourceLoader(portExposureLoaderOptions(input)),
    toMessage,
  )()
    .asyncAndThen((loader) => ResultAsync.fromPromise(loader.reload(), toMessage).map(() => loader))
    .map((loader): ResourceLoader => loader);
}

import {
  DefaultResourceLoader,
  type ResourceLoader,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Result, ResultAsync } from "neverthrow";
import { portExposurePrompt } from "../tailscale/prompt.ts";
import { environmentPrompt } from "./environment-prompt.ts";

type LoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];

export interface OrbResourceLoaderInput {
  readonly cwd: string;
  readonly agentDir: string;
  /** Shared with `createAgentSession`; omitted where the SDK default is used. */
  readonly settingsManager?: SettingsManager | undefined;
  readonly previewHost?: string | null;
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
export function orbResourceLoaderOptions(input: OrbResourceLoaderInput): LoaderOptions {
  const previewHost = input.previewHost ?? null;
  return {
    cwd: input.cwd,
    agentDir: input.agentDir,
    ...(input.settingsManager !== undefined ? { settingsManager: input.settingsManager } : {}),
    appendSystemPromptOverride: (base: string[]): string[] => [
      ...base,
      environmentPrompt,
      ...(previewHost !== null ? [portExposurePrompt(previewHost)] : []),
    ],
  };
}

/** Never rejects: construction and SDK reload failures use the typed error channel. */
export function createOrbResourceLoader(
  input: OrbResourceLoaderInput,
): ResultAsync<ResourceLoader, string> {
  const toMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);
  return Result.fromThrowable(
    () => new DefaultResourceLoader(orbResourceLoaderOptions(input)),
    toMessage,
  )()
    .asyncAndThen((loader) => ResultAsync.fromPromise(loader.reload(), toMessage).map(() => loader))
    .map((loader): ResourceLoader => loader);
}

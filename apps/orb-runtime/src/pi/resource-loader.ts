import { existsSync } from "node:fs";
import {
  DefaultResourceLoader,
  type ResourceLoader,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { RuntimeHooks } from "@pi-orb/protocol";
import { Result, ResultAsync } from "neverthrow";
import { bootHookPrompt } from "../hooks/prompt.ts";
import { portExposurePrompt } from "../tailscale/prompt.ts";
import { environmentPrompt } from "./environment-prompt.ts";

type LoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];

/**
 * Where the runtime image bakes pi-orb's own agent skills (docs/pi-adapter.md,
 * decided 2026-08-22). Deliberately outside `/workspace`: the orb's persistent
 * volume is mounted there and would shadow anything the image placed under it.
 * Providers with no image — the process host provider — simply do not have it.
 */
export const BAKED_SKILLS_DIR = "/opt/pi-orb/skills";

export interface OrbResourceLoaderInput {
  readonly cwd: string;
  readonly agentDir: string;
  /** Shared with `createAgentSession`; omitted where the SDK default is used. */
  readonly settingsManager?: SettingsManager | undefined;
  readonly previewHost?: string | null;
  /** Latest boot-hook outcomes; only failures reach the prompt. */
  readonly hooks?: RuntimeHooks;
  /**
   * Overridden only by tests. `null` disables the baked skills entirely;
   * omitting it uses `BAKED_SKILLS_DIR`.
   */
  readonly skillsDir?: string | null;
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
 * discovered. `additionalSkillPaths` is likewise additive — it merges with the
 * user and project skill directories the SDK finds on its own.
 *
 * The existence check is not defensive noise: the SDK tolerates a missing
 * additional skill path (`loadSkills` warns and skips it rather than throwing),
 * but `DefaultResourceLoader.reload()` then records a `type: "error"` skill
 * diagnostic for it. On a provider with no image the directory is legitimately
 * absent, and a permanent error diagnostic there would be a false alarm.
 */
export function orbResourceLoaderOptions(input: OrbResourceLoaderInput): LoaderOptions {
  const previewHost = input.previewHost ?? null;
  const hookPrompt = bootHookPrompt(input.hooks ?? {});
  const skillsDir = input.skillsDir === undefined ? BAKED_SKILLS_DIR : input.skillsDir;
  return {
    cwd: input.cwd,
    agentDir: input.agentDir,
    ...(input.settingsManager !== undefined ? { settingsManager: input.settingsManager } : {}),
    additionalSkillPaths: skillsDir !== null && existsSync(skillsDir) ? [skillsDir] : [],
    appendSystemPromptOverride: (base: string[]): string[] => [
      ...base,
      environmentPrompt,
      ...(previewHost !== null ? [portExposurePrompt(previewHost)] : []),
      ...(hookPrompt !== null ? [hookPrompt] : []),
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

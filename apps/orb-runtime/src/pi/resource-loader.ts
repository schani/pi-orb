import { statSync } from "node:fs";
import {
  DefaultResourceLoader,
  type ResourceLoader,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { RuntimeHooks } from "@pi-orb/protocol";
import { err, errAsync, ok, Result, ResultAsync } from "neverthrow";
import type { HookEnvReport } from "../hooks/env-file.ts";
import { bootHookPrompt } from "../hooks/prompt.ts";
import { portExposurePrompt } from "../tailscale/prompt.ts";
import { environmentPrompt } from "./environment-prompt.ts";
import { createOrbExtensions } from "./extensions/index.ts";
import { type McpExtensionDeps, mcpInventoryPrompt } from "./extensions/mcp.ts";

type LoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];

export interface OrbResourceLoaderInput {
  readonly cwd: string;
  readonly agentDir: string;
  /** Shared with `createAgentSession`; omitted where the SDK default is used. */
  readonly settingsManager?: SettingsManager | undefined;
  readonly previewHost?: string | null;
  /** Latest boot-hook outcomes; only failures reach the prompt. */
  readonly hooks?: RuntimeHooks;
  /** What the hooks' env file turned into; only its problems reach the prompt. */
  readonly hookEnv?: HookEnvReport | null;
  /** Provider-supplied install directory; tests may use null to disable it. */
  readonly skillsDir: string | null;
  readonly mcp?: McpExtensionDeps;
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
 */
export function orbResourceLoaderOptions(input: OrbResourceLoaderInput): LoaderOptions {
  const previewHost = input.previewHost ?? null;
  const hookPrompt = bootHookPrompt(input.hooks ?? {}, input.hookEnv ?? null);
  const mcpPrompt = mcpInventoryPrompt(input.mcp?.configs ?? []);
  return {
    cwd: input.cwd,
    agentDir: input.agentDir,
    ...(input.settingsManager !== undefined ? { settingsManager: input.settingsManager } : {}),
    extensionFactories: createOrbExtensions(input.mcp ? { mcp: input.mcp } : {}),
    additionalSkillPaths: input.skillsDir === null ? [] : [input.skillsDir],
    appendSystemPromptOverride: (base: string[]): string[] => [
      ...base,
      environmentPrompt,
      ...(previewHost !== null ? [portExposurePrompt(previewHost)] : []),
      ...(hookPrompt !== null ? [hookPrompt] : []),
      ...(mcpPrompt !== null ? [mcpPrompt] : []),
    ],
  };
}

/** Never rejects: construction and SDK reload failures use the typed error channel. */
export function createOrbResourceLoader(
  input: OrbResourceLoaderInput,
): ResultAsync<ResourceLoader, string> {
  const toMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);
  if (input.skillsDir !== null) {
    const skillsDir = input.skillsDir;
    const directory = Result.fromThrowable(
      () => statSync(skillsDir),
      (error) => `cannot read configured skills directory ${skillsDir}: ${toMessage(error)}`,
    )();
    if (directory.isErr()) return errAsync(directory.error);
    if (!directory.value.isDirectory()) {
      return errAsync(`configured skills path is not a directory: ${skillsDir}`);
    }
  }
  return Result.fromThrowable(
    () => new DefaultResourceLoader(orbResourceLoaderOptions(input)),
    toMessage,
  )()
    .asyncAndThen((loader) => ResultAsync.fromPromise(loader.reload(), toMessage).map(() => loader))
    .andThen((loader) => {
      const loaded = loader.getExtensions();
      if (loaded.errors.length > 0)
        return err(`Pi extension load failed: ${loaded.errors.map((e) => e.path).join(", ")}`);
      const names = new Set<string>();
      for (const extension of loaded.extensions) {
        for (const name of extension.tools.keys()) {
          if (names.has(name)) return err(`Pi extension tool name collision: ${name}`);
          names.add(name);
        }
      }
      return ok<ResourceLoader, string>(loader);
    });
}

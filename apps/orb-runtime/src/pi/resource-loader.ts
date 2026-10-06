import { statSync } from "node:fs";
import {
  DefaultResourceLoader,
  loadSkills,
  type ResourceLoader,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  McpConfig,
  PersonalInstructions,
  ProjectInstructions,
  RuntimeHooks,
} from "@pi-orb/protocol";
import { err, errAsync, ok, Result, ResultAsync } from "neverthrow";
import type { HookEnvReport } from "../hooks/env-file.ts";
import { bootHookPrompt } from "../hooks/prompt.ts";
import { repositoryResources } from "../repository-resources.ts";
import { portExposurePrompt } from "../tailscale/prompt.ts";
import { environmentPrompt } from "./environment-prompt.ts";
import type { NativeMcpExtensionDeps } from "./extensions/index.ts";
import { createOrbExtensions } from "./extensions/index.ts";
import { mcpInventoryPrompt } from "./extensions/mcp.ts";
import type { SubagentHost } from "./extensions/subagents.ts";

type LoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];

export interface OrbResourceLoaderInput {
  readonly cwd: string;
  readonly agentDir: string;
  /** Shared with `createAgentSession`; omitted where the SDK default is used. */
  readonly settingsManager?: SettingsManager | undefined;
  readonly previewHost?: string | null;
  readonly userTimeZone?: string | null;
  /** Latest boot-hook outcomes; only failures reach the prompt. */
  readonly hooks?: RuntimeHooks;
  /** What the hooks' env file turned into; only its problems reach the prompt. */
  readonly hookEnv?: HookEnvReport | null;
  /** Provider-supplied install directory; tests may use null to disable it. */
  readonly skillsDir: string | null;
  readonly mcp?: NativeMcpExtensionDeps;
  readonly mcpConfigs?: readonly McpConfig[];
  readonly subagents?: SubagentHost;
  readonly personalInstructions?: PersonalInstructions;
  readonly projectInstructions?: ProjectInstructions;
}

/** Managed prompts surround selected repository instructions. Skills use the
 * repository root policy plus trusted bundled assets; SDK extension wiring is retained.
 * Append overrides preserve SDK APPEND_SYSTEM.md discovery.
 */
export function orbResourceLoaderOptions(input: OrbResourceLoaderInput): LoaderOptions {
  const previewHost = input.previewHost ?? null;
  const userTimeZone = input.userTimeZone ?? null;
  // Capture the boot value: an SDK reload must not adopt a later account edit.
  const personalContent = input.personalInstructions?.content ?? "";
  const projectContent = input.projectInstructions?.content ?? "";
  const hookPrompt = bootHookPrompt(input.hooks ?? {}, input.hookEnv ?? null);
  const mcpPrompt = mcpInventoryPrompt(input.mcpConfigs ?? []);
  return {
    cwd: input.cwd,
    agentDir: input.agentDir,
    ...(input.settingsManager !== undefined ? { settingsManager: input.settingsManager } : {}),
    extensionFactories: createOrbExtensions({
      cwd: input.cwd,
      ...(input.mcp ? { mcp: input.mcp } : {}),
      ...(input.subagents ? { subagents: input.subagents } : {}),
    }),
    noContextFiles: true,
    noSkills: true,
    skillsOverride: () => {
      const resources = repositoryResources(input.cwd);
      if (resources.isErr())
        return {
          skills: [],
          diagnostics: [{ type: "error" as const, path: input.cwd, message: resources.error }],
        };
      return loadSkills({
        cwd: input.cwd,
        agentDir: input.agentDir,
        includeDefaults: false,
        skillPaths: [
          ...resources.value.skills,
          ...(input.skillsDir === null ? [] : [input.skillsDir]),
        ],
      });
    },
    agentsFilesOverride: () => ({
      agentsFiles: [
        ...(personalContent === ""
          ? []
          : [{ path: "pi-orb:personal/AGENTS.md", content: personalContent }]),
        ...repositoryResources(input.cwd)
          .map((resources) => resources.instructions)
          .unwrapOr([]),
        ...(projectContent === ""
          ? []
          : [{ path: "pi-orb:project/AGENTS.md", content: projectContent }]),
      ],
    }),
    additionalSkillPaths: input.skillsDir === null ? [] : [input.skillsDir],
    appendSystemPromptOverride: (base: string[]): string[] => [
      ...base,
      environmentPrompt,
      ...(previewHost !== null ? [portExposurePrompt(previewHost)] : []),
      ...(userTimeZone !== null
        ? [
            `User’s time zone: ${userTimeZone}. Present dates and times in this time zone unless they request another.`,
          ]
        : []),
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
  const repository = repositoryResources(input.cwd);
  if (repository.isErr()) return errAsync(repository.error);
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
          if (name.startsWith("mcp__") && !extension.path.startsWith("<inline:pi-orb:"))
            return err(`Pi extension tool name collision: ${name}`);
          if (names.has(name)) return err(`Pi extension tool name collision: ${name}`);
          names.add(name);
        }
      }
      return ok<ResourceLoader, string>(loader);
    });
}

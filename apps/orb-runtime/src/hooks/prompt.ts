import type { RuntimeHookStatus, RuntimeHooks } from "@pi-orb/protocol";
import type { HookEnvReport } from "./env-file.ts";

const explain = (status: RuntimeHookStatus): string => {
  switch (status.outcome) {
    case "failed":
      return `failed with exit code ${status.exitCode ?? "unknown"}`;
    case "timeout":
      return "was terminated after exceeding its deadline";
    case "hook_not_executable":
      return "is present but not executable (`chmod +x` it)";
    case "ok":
      return "succeeded";
  }
};

/**
 * A hook's env file the runtime could only partly use. Silent on a clean file:
 * the variables that did apply are simply present in the environment, and
 * naming them would spend context on a boot that went right.
 */
const envLines = (env: HookEnvReport | null): string[] => {
  if (env === null) return [];
  return [
    ...env.malformed.map(
      (reason) => `- \`${env.path}\` ${reason} — that line was skipped, the rest applied`,
    ),
    ...env.ignored.map(
      (name) => `- \`${env.path}\` set \`${name}\`, which the runtime owns; it was ignored`,
    ),
  ];
};

/**
 * The agent cannot see a boot hook's outcome on its own, and a broken hook is
 * exactly the thing it should fix first. Only failures are appended: a healthy
 * boot must not spend context saying so (docs/orb-setup-hook.md).
 */
export function bootHookPrompt(
  hooks: RuntimeHooks,
  env: HookEnvReport | null = null,
): string | null {
  const failed = [hooks.setup, hooks.resume].filter(
    (status): status is RuntimeHookStatus => status !== undefined && status.outcome !== "ok",
  );
  const envProblems = envLines(env);
  if (failed.length === 0 && envProblems.length === 0) return null;
  return [
    "## Boot hooks",
    "",
    "This orb runs the repository's `.agents/setup` (once per compute incarnation, without the",
    "orb's identity) and `.agents/resume` (on every start, with it). This boot:",
    "",
    ...failed.map(
      (status) => `- \`.agents/${status.hook}\` ${explain(status)}; log: \`${status.logPath}\``,
    ),
    ...envProblems,
    "",
    "The orb started anyway, so the environment those hooks were supposed to prepare may be",
    "incomplete. Read the log before assuming a missing tool or credential is a platform problem,",
    "and fix the hook rather than working around it — it runs again on the next start.",
  ].join("\n");
}

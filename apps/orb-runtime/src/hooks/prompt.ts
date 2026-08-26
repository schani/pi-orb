import type { RuntimeHookStatus, RuntimeHooks } from "@pi-orb/protocol";

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
 * The agent cannot see a boot hook's outcome on its own, and a broken hook is
 * exactly the thing it should fix first. Only failures are appended: a healthy
 * boot must not spend context saying so (docs/orb-setup-hook.md).
 */
export function bootHookPrompt(hooks: RuntimeHooks): string | null {
  const failed = [hooks.setup, hooks.resume].filter(
    (status): status is RuntimeHookStatus => status !== undefined && status.outcome !== "ok",
  );
  if (failed.length === 0) return null;
  return [
    "## Boot hooks",
    "",
    "This orb runs the repository's `.agents/setup` (once per compute incarnation, without the",
    "orb's identity) and `.agents/resume` (on every start, with it). This boot:",
    "",
    ...failed.map(
      (status) => `- \`.agents/${status.hook}\` ${explain(status)}; log: \`${status.logPath}\``,
    ),
    "",
    "The orb started anyway, so the environment those hooks were supposed to prepare may be",
    "incomplete. Read the log before assuming a missing tool or credential is a platform problem,",
    "and fix the hook rather than working around it — it runs again on the next start.",
  ].join("\n");
}

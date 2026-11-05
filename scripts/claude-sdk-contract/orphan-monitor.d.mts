import type { Options } from "@anthropic-ai/claude-agent-sdk";

type Spawn = NonNullable<Options["spawnClaudeCodeProcess"]>;
export function withOrphanMonitor(options: {
  cwd: string;
  configDir: string;
  sessionId: string;
  artifactName: string;
  run(context: {
    env: NonNullable<Options["env"]>;
    wrapSpawn(original?: Spawn): Spawn;
    events: Record<string, unknown>[];
    trackQuery(query: { close(): void }): void;
    cancel(): void;
  }): Promise<{ initialHumanUuid: string | undefined }>;
}): Promise<{
  taskId: string;
  runResult: { initialHumanUuid: string | undefined };
  events: Record<string, unknown>[];
}>;

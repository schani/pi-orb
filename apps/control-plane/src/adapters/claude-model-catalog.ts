import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ResultAsync } from "neverthrow";
import { claudeChildEnvironment } from "../../../orb-runtime/src/claude/auth.ts";
import { latestClaudeModels } from "../../../orb-runtime/src/claude/models.ts";
import { spawnModelError } from "../domain/orb-spawn-model.ts";

/** SDK control request only: no user input, inference, native session, or retained config. */
export function discoverClaudeModels(token: string) {
  return ResultAsync.fromThrowable(
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "orb-model-catalog-"));
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), 10_000);
      const prompt = async function* (): AsyncGenerator<SDKUserMessage> {
        await new Promise<void>((resolve) => {
          if (abortController.signal.aborted) resolve();
          else abortController.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      };
      let process: ReturnType<typeof query> | undefined;
      try {
        process = query({
          prompt: prompt(),
          options: {
            cwd: directory,
            env: claudeChildEnvironment(globalThis.process.env, token, directory),
            persistSession: false,
            settingSources: [],
            tools: [],
            mcpServers: {},
            abortController,
          },
        });
        const advertised = await process.supportedModels();
        return latestClaudeModels(advertised).map((model) => {
          const resolved = advertised.find((entry) => entry.value === model.id)?.resolvedModel;
          return { ...model, aliases: resolved === undefined ? [] : [resolved] };
        });
      } finally {
        clearTimeout(timeout);
        abortController.abort();
        try {
          process?.close();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    },
    () => spawnModelError("unavailable", "Claude model catalog unavailable."),
  )();
}

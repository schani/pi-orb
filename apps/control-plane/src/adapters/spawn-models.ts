import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { err, ok, Result, ResultAsync } from "neverthrow";
import { claudeChildEnvironment } from "../../../orb-runtime/src/claude/auth.ts";
import { latestClaudeModels } from "../../../orb-runtime/src/claude/models.ts";
import { eligibleCodexModels } from "../../../orb-runtime/src/domain/model-select.ts";
import { getToken } from "../domain/broker.ts";
import type { ClaudeSubscriptionAuth } from "../domain/claude-auth.ts";
import type { CheckSpawnModel, SpawnModelError } from "../domain/orb-spawning.ts";
import type { BrokerDeps } from "../domain/ports.ts";

const unavailable = (): SpawnModelError => ({
  type: "spawn_model_error",
  reason: "unavailable",
  message: "Owner model lookup unavailable.",
});
const invalid = (): SpawnModelError => ({
  type: "spawn_model_error",
  reason: "invalid",
  message: "Unknown or unavailable spawn model.",
});
const disconnected = (): SpawnModelError => ({
  type: "spawn_model_error",
  reason: "disconnected",
  message: "Connect the requested model provider before spawning.",
});

export function createSpawnModelCheck(
  brokerForUser: (owner: string) => BrokerDeps,
  claudeAuth: Pick<ClaudeSubscriptionAuth, "grant">,
): CheckSpawnModel {
  return (task, owner, model) =>
    model.provider === "claude"
      ? claudeAuth
          .grant(task, owner)
          .mapErr(unavailable)
          .andThen((grant) =>
            grant === null ? err(disconnected()) : checkClaudeSpawnModel(grant.token, model.id),
          )
      : ResultAsync.fromSafePromise(
          getToken(task, brokerForUser(owner), "openai-codex", { reason: "startup" }),
        )
          .andThen((result) => result)
          .mapErr((error) => (error.type === "auth_required" ? disconnected() : unavailable()))
          .andThen(() =>
            Result.fromThrowable(
              () =>
                eligibleCodexModels(getBuiltinModels("openai-codex")).some(
                  (option) => option.id === model.id,
                ),
              unavailable,
            )(),
          )
          .andThen((available) => (available ? ok(undefined) : err(invalid())));
}

/** SDK control request only: no user input, inference, native session, or retained config. */
function checkClaudeSpawnModel(token: string, id: string) {
  return ResultAsync.fromThrowable(async () => {
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
      return latestClaudeModels(advertised).some((model) => model.id === id);
    } finally {
      clearTimeout(timeout);
      abortController.abort();
      try {
        process?.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }, unavailable)().andThen((available) => (available ? ok(undefined) : err(invalid())));
}

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { OrbModelOption } from "@pi-orb/protocol";
import { err, ok, Result, ResultAsync } from "neverthrow";
import { claudeChildEnvironment } from "../../../orb-runtime/src/claude/auth.ts";
import { latestClaudeModels } from "../../../orb-runtime/src/claude/models.ts";
import {
  codexModelDisplayName,
  eligibleCodexModels,
} from "../../../orb-runtime/src/domain/model-select.ts";
import { getToken } from "../domain/broker.ts";
import type { ClaudeSubscriptionAuth } from "../domain/claude-auth.ts";
import type { ListOrbModelOptions, ModelCatalogError } from "../domain/orb-models.ts";
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

const catalogUnavailable = (): ModelCatalogError => ({
  type: "model_catalog_error",
  reason: "unavailable",
});
const catalogDisconnected = (): ModelCatalogError => ({
  type: "model_catalog_error",
  reason: "disconnected",
});

export function createOrbModelCatalog(
  brokerForUser: (owner: string) => BrokerDeps,
  claudeAuth: Pick<ClaudeSubscriptionAuth, "grant">,
): ListOrbModelOptions {
  return (task, owner, harness) =>
    harness === "claude"
      ? ResultAsync.fromThrowable(async () => claudeAuth.grant(task, owner), catalogUnavailable)()
          .andThen((result) => result.mapErr(catalogUnavailable))
          .andThen((grant) =>
            grant === null ? err(catalogDisconnected()) : listClaudeModels(grant.token),
          )
      : ResultAsync.fromThrowable(
          () => getToken(task, brokerForUser(owner), "openai-codex", { reason: "startup" }),
          catalogUnavailable,
        )()
          .andThen((result) =>
            result.mapErr((error) =>
              error.type === "auth_required" ? catalogDisconnected() : catalogUnavailable(),
            ),
          )
          .andThen(() =>
            Result.fromThrowable(
              () =>
                eligibleCodexModels(getBuiltinModels("openai-codex")).map(({ id }) => ({
                  provider: "openai-codex",
                  id,
                  name: codexModelDisplayName(id),
                })),
              catalogUnavailable,
            )(),
          );
}

export function createSpawnModelCheck(
  brokerForUser: (owner: string) => BrokerDeps,
  claudeAuth: Pick<ClaudeSubscriptionAuth, "grant">,
): CheckSpawnModel {
  const list = createOrbModelCatalog(brokerForUser, claudeAuth);
  return (task, owner, model) =>
    list(task, owner, model.provider === "claude" ? "claude" : "pi")
      .mapErr((error) => (error.reason === "disconnected" ? disconnected() : unavailable()))
      .andThen((models) =>
        models.some((option) => option.provider === model.provider && option.id === model.id)
          ? ok(undefined)
          : err(invalid()),
      );
}

type CatalogChild = { process: ChildProcess; exited: Promise<void> };

const cleanupFailed = (): ModelCatalogError => ({
  type: "model_catalog_error",
  reason: "cleanup_failed",
});

async function exitedWithin(child: CatalogChild, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      child.exited.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function disposeClaudeCatalog(
  directory: string,
  probe: ReturnType<typeof query> | undefined,
  child: CatalogChild | undefined,
): Promise<Result<void, ModelCatalogError>> {
  const close = ResultAsync.fromThrowable(async () => {
    await probe?.return();
  }, cleanupFailed)();
  const remove = ResultAsync.fromThrowable(
    () => rm(directory, { recursive: true, force: true }),
    cleanupFailed,
  );

  // Query.return() awaits SDK cleanup, but its process wait is bounded. Keep
  // the config intact until actual exit, including after signal escalation.
  if (child && !(await exitedWithin(child, 3_000))) {
    Result.fromThrowable(() => child.process.kill("SIGKILL"), cleanupFailed)();
    if (!(await exitedWithin(child, 2_000))) {
      // Exit is not confirmed. Bound the request without racing a live writer.
      void child.exited.then(remove);
      return err(cleanupFailed());
    }
  }
  const removed = await remove();
  return (await close).andThen(() => removed);
}

/** SDK control request only: no user input, inference, native session, or retained config. */
function listClaudeModels(token: string): ResultAsync<OrbModelOption[], ModelCatalogError> {
  return ResultAsync.fromThrowable(async () => {
    const directory = await mkdtemp(join(tmpdir(), "orb-model-catalog-"));
    const abortController = new AbortController();
    let deadlineFired = false;
    const timeout = setTimeout(() => {
      deadlineFired = true;
      abortController.abort();
    }, 10_000);
    const prompt = async function* (): AsyncGenerator<SDKUserMessage> {
      await new Promise<void>((resolve) => {
        if (abortController.signal.aborted) resolve();
        else abortController.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    };
    let probe: ReturnType<typeof query> | undefined;
    let child: CatalogChild | undefined;
    const models = await ResultAsync.fromThrowable(
      async () => {
        probe = query({
          prompt: prompt(),
          options: {
            cwd: directory,
            env: claudeChildEnvironment(globalThis.process.env, token, directory),
            persistSession: false,
            settingSources: [],
            tools: [],
            mcpServers: {},
            abortController,
            spawnClaudeCodeProcess: ({ command, args, cwd, env, signal }) => {
              // A timed-out probe must not spawn after cleanup has started.
              abortController.signal.throwIfAborted();
              const process = spawn(command, args, {
                cwd,
                env,
                signal,
                stdio: ["pipe", "pipe", "ignore"],
                windowsHide: true,
              });
              const exited = new Promise<void>((resolve) => {
                process.once("exit", resolve);
                // Also settles if spawn failed and no 'exit' event will arrive.
                process.once("close", resolve);
              });
              child = { process, exited };
              return process;
            },
          },
        });
        const advertised = await probe.supportedModels();
        return latestClaudeModels(advertised).map(({ provider, id, name }) => ({
          provider,
          id,
          name,
        }));
      },
      (): ModelCatalogError => ({
        type: "model_catalog_error",
        reason: deadlineFired ? "probe_timeout" : "probe_failed",
      }),
    )();
    clearTimeout(timeout);
    abortController.abort();
    const cleaned = await disposeClaudeCatalog(directory, probe, child);
    return cleaned.andThen(() => models);
  }, catalogUnavailable)().andThen((result) => result);
}

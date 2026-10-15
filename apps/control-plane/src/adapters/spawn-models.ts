import { getSupportedThinkingLevels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { err, ok, okAsync, ResultAsync } from "neverthrow";
import {
  CLAUDE_MODEL_FAMILIES,
  latestClaudeModels,
} from "../../../orb-runtime/src/claude/models.ts";
import {
  codexModelDisplayName,
  eligibleCodexModels,
} from "../../../orb-runtime/src/pi/model-select.ts";
import {
  matchesSpawnModel,
  type SpawnModelCatalog,
  type SpawnModelError,
  type SpawnModelOption,
  type SpawnModels,
  spawnModelError,
} from "../domain/orb-spawn-model.ts";
import type { BrokerDeps, StoredClaudeSubscriptionCredential } from "../domain/ports.ts";

const unavailable = () => spawnModelError("unavailable", "Owner model catalog unavailable.");
export function createSpawnModels(
  brokerForUser: (ownerUserId: string) => BrokerDeps,
  claudeModels: (token: string) => ResultAsync<readonly SpawnModelOption[], SpawnModelError>,
): SpawnModels {
  return {
    read(task, ownerUserId, selector) {
      const broker = brokerForUser(ownerUserId);
      return ResultAsync.fromThrowable(async () => {
        const runtime = await ModelRuntime.create({
          credentials: new InMemoryCredentialStore(),
          modelsPath: null,
          allowModelNetwork: false,
          refreshOnCreate: false,
        });
        return eligibleCodexModels(runtime.getModels("openai-codex")).map((model) => ({
          provider: model.provider,
          id: model.id,
          name: codexModelDisplayName(model.id),
          thinkingLevels: getSupportedThinkingLevels(model),
        }));
      }, unavailable)().andThen((pi) => {
        const claudePolicy = latestClaudeModels(
          CLAUDE_MODEL_FAMILIES.map((value) => ({
            value,
            displayName: value,
            description: "",
          })),
        );
        const provider =
          typeof selector !== "string"
            ? selector.provider
            : selector.includes("/")
              ? selector.slice(0, selector.indexOf("/"))
              : undefined;
        const piCandidate =
          provider === "openai-codex" ||
          (provider === undefined && pi.some((model) => matchesSpawnModel(selector, model)));
        const claudeCandidate =
          provider === "claude" ||
          (provider === undefined &&
            (!piCandidate || claudePolicy.some((model) => matchesSpawnModel(selector, model))));
        const codex: ResultAsync<SpawnModelCatalog, SpawnModelError> = !piCandidate
          ? okAsync({ models: pi, disconnected: [] })
          : broker.pointers
              .readPointer(task, "openai-codex")
              .mapErr(unavailable)
              .andThen((row) =>
                row?.secretVersion == null
                  ? okAsync(null)
                  : broker.secrets
                      .readSecret(task, "openai-codex", row.secretVersion)
                      .mapErr(unavailable),
              )
              .map((secret) => ({
                models: pi,
                disconnected: secret === null ? ["openai-codex"] : [],
              }));
        const claude: ResultAsync<SpawnModelCatalog, SpawnModelError> = !claudeCandidate
          ? okAsync({ models: [], disconnected: [] })
          : broker.pointers
              .readPointer(task, "claude")
              .mapErr(unavailable)
              .andThen((row) => {
                if (row?.secretVersion == null)
                  return ok<SpawnModelCatalog, SpawnModelError>({
                    models: claudePolicy,
                    disconnected: ["claude"],
                  });
                return broker.secrets
                  .readSecret<StoredClaudeSubscriptionCredential>(task, "claude", row.secretVersion)
                  .mapErr(unavailable)
                  .andThen((secret) =>
                    secret?.kind === "claude_subscription"
                      ? claudeModels(secret.token).andThen((models) =>
                          claudePolicy.some((model) => matchesSpawnModel(selector, model)) &&
                          !models.some((model) => matchesSpawnModel(selector, model))
                            ? err(
                                spawnModelError(
                                  "unadvertised",
                                  "Selected Claude model is not advertised.",
                                ),
                              )
                            : ok({ models, disconnected: [] }),
                        )
                      : err(unavailable()),
                  );
              });
        return ResultAsync.combine([codex, claude]).map(([piCatalog, claudeCatalog]) => ({
          models: [...piCatalog.models, ...claudeCatalog.models],
          disconnected: [...piCatalog.disconnected, ...claudeCatalog.disconnected],
        }));
      });
    },
  };
}

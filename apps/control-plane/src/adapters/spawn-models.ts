import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
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
import type { BrokerDeps, StoredSecret } from "../domain/ports.ts";

const unavailable = () => spawnModelError("unavailable", "Owner model catalog unavailable.");
export function createSpawnModels(
  brokerForUser: (ownerUserId: string) => BrokerDeps,
  claudeModels: (token: string) => ResultAsync<readonly SpawnModelOption[], SpawnModelError>,
): SpawnModels {
  return {
    read(task, ownerUserId, selector) {
      const broker = brokerForUser(ownerUserId);
      const credential = (provider: string) =>
        broker.pointers
          .readPointer(task, provider)
          .mapErr(unavailable)
          .andThen((row) =>
            row?.secretVersion == null
              ? okAsync(null)
              : broker.secrets
                  .readSecret<StoredSecret>(task, provider, row.secretVersion)
                  .mapErr(unavailable)
                  .andThen((secret) =>
                    secret === null && provider === "claude" ? err(unavailable()) : ok(secret),
                  ),
          );
      return ResultAsync.fromThrowable(async () => {
        return eligibleCodexModels(getBuiltinModels("openai-codex")).map((model) => ({
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
        const codex = piCandidate
          ? credential("openai-codex").map((secret) => (secret === null ? ["openai-codex"] : []))
          : okAsync<string[]>([]);
        return codex.andThen((disconnected): ResultAsync<SpawnModelCatalog, SpawnModelError> => {
          if (!claudeCandidate) return okAsync({ models: pi, disconnected });
          return credential("claude").andThen((secret) => {
            if (secret === null)
              return ok({
                models: [...pi, ...claudePolicy],
                disconnected: [...disconnected, "claude"],
              });
            if (!("kind" in secret) || secret.kind !== "claude_subscription")
              return err(unavailable());
            return claudeModels(secret.token).andThen((models) =>
              claudePolicy.some((model) => matchesSpawnModel(selector, model)) &&
              !models.some((model) => matchesSpawnModel(selector, model))
                ? err(spawnModelError("unadvertised", "Selected Claude model is not advertised."))
                : ok({ models: [...pi, ...models], disconnected }),
            );
          });
        });
      });
    },
  };
}

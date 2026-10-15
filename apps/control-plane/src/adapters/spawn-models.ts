import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { err, ok, Result, type ResultAsync } from "neverthrow";
import { eligibleCodexModels } from "../../../orb-runtime/src/pi/model-select.ts";
import type { CheckSpawnModel, SpawnModelError } from "../domain/orb-spawn-model.ts";
import type { BrokerDeps, StoredSecret } from "../domain/ports.ts";

const unavailable = (): SpawnModelError => ({
  type: "spawn_model_error",
  reason: "unavailable",
  message: "Owner model lookup unavailable.",
});
export function createSpawnModelCheck(
  brokerForUser: (ownerUserId: string) => BrokerDeps,
  checkClaude: (token: string, id: string) => ResultAsync<void, SpawnModelError>,
): CheckSpawnModel {
  return (task, ownerUserId, model) => {
    const broker = brokerForUser(ownerUserId);
    return broker.pointers
      .readPointer(task, model.provider)
      .mapErr(unavailable)
      .andThen((row) => {
        if (row?.secretVersion == null)
          return err({
            type: "spawn_model_error" as const,
            reason: "disconnected" as const,
            message: `Connect ${model.provider} before spawning this model.`,
          });
        return broker.secrets
          .readSecret<StoredSecret>(task, model.provider, row.secretVersion)
          .mapErr(unavailable)
          .andThen((secret) => {
            if (secret === null) return err(unavailable());
            if (model.provider === "claude")
              return "kind" in secret && secret.kind === "claude_subscription"
                ? checkClaude(secret.token, model.id)
                : err(unavailable());
            if (
              !("access" in secret) ||
              !secret.access ||
              !secret.refresh ||
              !secret.accountId ||
              !Number.isFinite(secret.expiresAt)
            )
              return err(unavailable());
            return Result.fromThrowable(
              () =>
                eligibleCodexModels(getBuiltinModels("openai-codex")).some(
                  (option) => option.id === model.id,
                ),
              unavailable,
            )().andThen((available) =>
              available
                ? ok(undefined)
                : err({
                    type: "spawn_model_error" as const,
                    reason: "invalid" as const,
                    message: "Unknown or unavailable Pi model.",
                  }),
            );
          });
      });
  };
}

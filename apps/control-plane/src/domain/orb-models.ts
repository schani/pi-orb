import type { HarnessKind, OrbModelOption, PendingModel } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, type ResultAsync } from "neverthrow";
import {
  CLAUDE_MODEL_FAMILIES,
  claudeModelDisplayName,
} from "../../../orb-runtime/src/claude/models.ts";
import { SELECTABLE_CODEX_MODELS } from "../../../orb-runtime/src/domain/model-select.ts";
import type { StoreError } from "./errors.ts";
import { logOrbEvent } from "./log.ts";
import { canQueueModel, type OrbListRow } from "./orb.ts";
import { readOrb } from "./orb-read.ts";
import type { ControlPlaneStore } from "./ports.ts";

export const offlineModelOptions: Record<HarnessKind, OrbModelOption[]> = {
  claude: CLAUDE_MODEL_FAMILIES.map((id) => ({
    provider: "claude",
    id,
    name: claudeModelDisplayName(id),
  })),
  pi: SELECTABLE_CODEX_MODELS.map((model) => ({ provider: "openai-codex", ...model })),
};

type Refusal = {
  readonly type: "orb_model_refusal";
  readonly code: "not_found" | "conflict" | "invalid_request";
};
const refuse = (code: Refusal["code"]) => err({ type: "orb_model_refusal", code } as const);

export function queueOrbModel(
  task: SimulationTask,
  store: ControlPlaneStore,
  orbId: string,
  pending: PendingModel,
): ResultAsync<OrbListRow, StoreError | Refusal> {
  const { provider, id } = pending.model;
  return store.getOrb(task, orbId).andThen((orb) => {
    if (orb === null) return refuse("not_found");
    if (!canQueueModel(orb)) return refuse("conflict");
    if (
      !offlineModelOptions[orb.harness].some(
        (model) => model.provider === provider && model.id === id,
      )
    )
      return refuse("invalid_request");
    return store.queueModel(task, orbId, pending).andThen((queued) => {
      if (!queued) return refuse("conflict");
      logOrbEvent(task, orbId, "model-queued", {
        changeId: pending.changeId,
        model: `${provider}/${id}`,
      });
      return readOrb(task, store, orbId).andThen((updated) =>
        updated === null ? refuse("not_found") : ok(updated),
      );
    });
  });
}

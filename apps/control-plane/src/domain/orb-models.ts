import type { HarnessKind, OrbModelOption, PendingModel } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, errAsync, ok, type ResultAsync } from "neverthrow";
import type { StoreError } from "./errors.ts";
import { logOrbEvent } from "./log.ts";
import { canQueueModel, type OrbListRow, type OrbRow } from "./orb.ts";
import { readOrb } from "./orb-read.ts";
import type { ControlPlaneDeps } from "./ports.ts";

export type ModelCatalogError = {
  readonly type: "model_catalog_error";
  readonly reason:
    | "disconnected"
    | "unavailable"
    | "probe_timeout"
    | "probe_failed"
    | "cleanup_failed";
};

export type ListOrbModelOptions = (
  task: SimulationTask,
  ownerUserId: string,
  harness: HarnessKind,
) => ResultAsync<OrbModelOption[], ModelCatalogError>;

type OrbModelRefusal = {
  readonly type: "orb_model_refusal";
  readonly code: "not_found" | "conflict" | "invalid_request";
  readonly message: string;
};
export type OrbModelError = StoreError | ModelCatalogError | OrbModelRefusal;

type OrbModelDeps = Pick<ControlPlaneDeps, "store" | "listOrbModelOptions">;

const notFound = (): OrbModelRefusal => ({
  type: "orb_model_refusal",
  code: "not_found",
  message: "orb not found",
});
const conflict = (): OrbModelRefusal => ({
  type: "orb_model_refusal",
  code: "conflict",
  message: "orb no longer accepts offline model selection",
});
const invalidModel = (): OrbModelRefusal => ({
  type: "orb_model_refusal",
  code: "invalid_request",
  message: "model is not available for this orb's harness",
});

export function modelProviderForHarness(harness: HarnessKind): "claude" | "openai-codex" {
  return harness === "claude" ? "claude" : "openai-codex";
}

function lookupEligibleOrb(
  task: SimulationTask,
  store: ControlPlaneDeps["store"],
  orbId: string,
): ResultAsync<{ orb: OrbRow; ownerUserId: string }, StoreError | OrbModelRefusal> {
  return store.getOrb(task, orbId).andThen((orb) => {
    if (orb === null) return errAsync(notFound());
    if (!canQueueModel(orb)) return errAsync(conflict());
    return store.getProject(task, orb.projectId).andThen((project) => {
      if (project === null) return err(notFound());
      if (project.state !== "active") return err(conflict());
      return ok({ orb, ownerUserId: project.ownerUserId });
    });
  });
}

export function readOrbModelOptions(
  task: SimulationTask,
  deps: OrbModelDeps,
  orbId: string,
): ResultAsync<OrbModelOption[], OrbModelError> {
  return lookupEligibleOrb(task, deps.store, orbId).andThen(({ orb, ownerUserId }) =>
    deps.listOrbModelOptions(task, ownerUserId, orb.harness),
  );
}

export function queueOrbModel(
  task: SimulationTask,
  deps: OrbModelDeps,
  orbId: string,
  pending: PendingModel,
): ResultAsync<OrbListRow, OrbModelError> {
  const { provider, id } = pending.model;
  return lookupEligibleOrb(task, deps.store, orbId)
    .andThen(({ orb, ownerUserId }) =>
      provider !== modelProviderForHarness(orb.harness)
        ? errAsync(invalidModel())
        : deps.listOrbModelOptions(task, ownerUserId, orb.harness),
    )
    .andThen((models) =>
      models.some((option) => option.id === id && option.provider === provider)
        ? deps.store.queueModel(task, orbId, pending)
        : errAsync(invalidModel()),
    )
    .andThen((queued) => {
      if (!queued) return errAsync(conflict());
      logOrbEvent(task, orbId, "model-queued", {
        changeId: pending.changeId,
        model: `${provider}/${id}`,
      });
      return readOrb(task, deps.store, orbId).andThen((orb) =>
        orb === null ? err(notFound()) : ok(orb),
      );
    });
}

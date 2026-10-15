import type { HarnessKind, ModelOption, OrbSpawnRequest } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, type Result, type ResultAsync } from "neverthrow";

export type InitialModel = Pick<ModelOption, "provider" | "id">;
export interface SpawnModelError {
  readonly type: "spawn_model_error";
  readonly reason: "invalid" | "unadvertised" | "ambiguous" | "disconnected" | "unavailable";
  readonly message: string;
}
export interface SpawnModelOption extends ModelOption {
  readonly aliases?: readonly string[];
}
export interface SpawnModelCatalog {
  readonly models: readonly SpawnModelOption[];
  readonly disconnected: readonly string[];
}
export interface SpawnModels {
  read(
    task: SimulationTask,
    ownerUserId: string,
    selector: NonNullable<OrbSpawnRequest["model"]>,
  ): ResultAsync<SpawnModelCatalog, SpawnModelError>;
}
export function spawnModelError(
  reason: SpawnModelError["reason"],
  message: string,
): SpawnModelError {
  return { type: "spawn_model_error", reason, message };
}
export function resolveSpawnModel(
  selector: NonNullable<OrbSpawnRequest["model"]>,
  catalog: SpawnModelCatalog,
): Result<{ model: InitialModel; harness: HarnessKind }, SpawnModelError> {
  const matches = catalog.models.filter((model) => matchesSpawnModel(selector, model));
  if (matches.length > 1)
    return err(
      spawnModelError(
        "ambiguous",
        `Ambiguous model; use ${matches.map((m) => `${m.provider}/${m.id}`).join(", ")}.`,
      ),
    );
  const selected = matches[0];
  if (!selected) return err(spawnModelError("invalid", "Unknown or unadvertised model."));
  if (catalog.disconnected.includes(selected.provider))
    return err(
      spawnModelError("disconnected", `Connect ${selected.provider} before spawning this model.`),
    );
  const harness =
    selected.provider === "openai-codex" ? "pi" : selected.provider === "claude" ? "claude" : null;
  if (harness === null) return err(spawnModelError("invalid", "Unsupported spawn model provider."));
  return ok({ model: { provider: selected.provider, id: selected.id }, harness });
}

export function matchesSpawnModel(
  selector: NonNullable<OrbSpawnRequest["model"]>,
  model: SpawnModelOption,
): boolean {
  if (typeof selector !== "string")
    return (
      model.provider === selector.provider &&
      (model.id === selector.id || model.aliases?.includes(selector.id) === true)
    );
  if (selector.includes("/")) {
    const slash = selector.indexOf("/");
    return (
      model.provider === selector.slice(0, slash) &&
      (model.id === selector.slice(slash + 1) ||
        model.aliases?.includes(selector.slice(slash + 1)) === true)
    );
  }
  return (
    model.id === selector ||
    model.aliases?.includes(selector) === true ||
    model.name.toLowerCase() === selector.toLowerCase()
  );
}

import type { AgentSettings, HarnessKind, ModelOption, OrbSpawnRequest } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, type Result, type ResultAsync } from "neverthrow";

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
): Result<AgentSettings["model"], SpawnModelError> {
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
  if (spawnModelHarness(selected.provider) === null)
    return err(spawnModelError("invalid", "Unsupported spawn model provider."));
  return ok({ provider: selected.provider, id: selected.id });
}

export function spawnModelHarness(provider: string): HarnessKind | null {
  return provider === "openai-codex" ? "pi" : provider === "claude" ? "claude" : null;
}

export function matchesSpawnModel(
  selector: NonNullable<OrbSpawnRequest["model"]>,
  model: SpawnModelOption,
): boolean {
  if (typeof selector === "string" && !selector.includes("/"))
    return (
      model.id === selector ||
      model.aliases?.includes(selector) === true ||
      model.name.toLowerCase() === selector.toLowerCase()
    );
  const ref =
    typeof selector === "string"
      ? {
          provider: selector.slice(0, selector.indexOf("/")),
          id: selector.slice(selector.indexOf("/") + 1),
        }
      : selector;
  return (
    model.provider === ref.provider &&
    (model.id === ref.id || model.aliases?.includes(ref.id) === true)
  );
}

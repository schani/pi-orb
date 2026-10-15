import type { HarnessKind, OrbSpawnRequest } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import type { ResultAsync } from "neverthrow";

export interface SpawnModelError {
  readonly type: "spawn_model_error";
  readonly reason: "invalid" | "disconnected" | "unavailable";
  readonly message: string;
}

export type CheckSpawnModel = (
  task: SimulationTask,
  ownerUserId: string,
  model: NonNullable<OrbSpawnRequest["model"]>,
) => ResultAsync<void, SpawnModelError>;

export function spawnModelHarness(provider: string): HarnessKind | null {
  return provider === "openai-codex" ? "pi" : provider === "claude" ? "claude" : null;
}

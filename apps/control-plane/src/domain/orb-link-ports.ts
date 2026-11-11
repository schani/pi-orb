import type { SimulationTask } from "determined";
import type { ResultAsync } from "neverthrow";
import type { StoreError } from "./errors.ts";

export interface OrbLinkRow {
  readonly url: string;
  readonly addedAt: number;
}

export interface OrbLinkStore {
  /** True when the link was not already registered. */
  addOrbLink(
    task: SimulationTask,
    input: { orbId: string; url: string; now: number },
  ): ResultAsync<boolean, StoreError>;
  /** True when a link was removed. */
  removeOrbLink(
    task: SimulationTask,
    input: { orbId: string; url: string },
  ): ResultAsync<boolean, StoreError>;
  listOrbLinks(task: SimulationTask, orbId: string): ResultAsync<readonly OrbLinkRow[], StoreError>;
}

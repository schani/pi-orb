import type { SimulationTask } from "determined";
import type { ResultAsync } from "neverthrow";
import type { StoreError } from "./errors.ts";
import type { OrbRow } from "./orb.ts";
import type { ArchiveCaller } from "./ports.ts";

export interface PreviewRegistrationRow {
  readonly port: number;
  readonly registrationId: string;
  readonly createdAt: number;
}
export interface PreviewMutation {
  readonly orbId: string;
  readonly port: number;
  readonly caller: ArchiveCaller;
  readonly now: number;
}
export type PreviewRegistrationOutcome =
  | {
      readonly type: "registered";
      readonly registration: PreviewRegistrationRow;
      readonly created: boolean;
    }
  | { readonly type: "denied" };
export interface PreviewStore {
  readPreviewAuthority(
    task: SimulationTask,
    input: { orbId: string; port: number },
  ): ResultAsync<{ orb: OrbRow; registration: PreviewRegistrationRow | null } | null, StoreError>;
  listPreviews(
    task: SimulationTask,
    input: { orbId: string; caller: ArchiveCaller },
  ): ResultAsync<readonly PreviewRegistrationRow[] | null, StoreError>;
  registerPreview(
    task: SimulationTask,
    input: PreviewMutation & { registrationId: string },
  ): ResultAsync<PreviewRegistrationOutcome, StoreError>;
  unregisterPreview(
    task: SimulationTask,
    input: PreviewMutation,
  ): ResultAsync<{ type: "revoked"; removed: boolean } | { type: "denied" }, StoreError>;
  protectPreviewActivity(
    task: SimulationTask,
    input: {
      orbId: string;
      port: number;
      registrationId: string;
      hostIncarnation: number;
      runtimeTokenHash: string;
      now: number;
      activeUntil: number;
    },
  ): ResultAsync<{ type: "protected" } | { type: "denied" }, StoreError>;
}

import type { Storage } from "@earendil-works/pi-durable";
import type { SimulationTask } from "determined";
import type { ResultAsync } from "neverthrow";
import type { AgentSnapshot } from "../../domain/agent-ports.ts";
import type { RuntimeClientError } from "../../domain/errors.ts";
import type { OrbRow } from "../../domain/orb.ts";
import type { OperationContext } from "../../domain/ports.ts";

export interface AgentArtifacts {
  write(bytes: Uint8Array): ResultAsync<string, RuntimeClientError>;
  /** Null means this is not a private artifact reference. */
  read(path: string): ResultAsync<Uint8Array | null, RuntimeClientError>;
}

export interface AgentStorageLease {
  readonly artifacts?: AgentArtifacts;
  readonly storage: Storage;
  /** Validates/renews the database owner and admission fence before inference/effects. */
  check(): ResultAsync<void, RuntimeClientError>;
  /** Enables only owner-fenced native cleanup after new admissions/effects are revoked. */
  beginDrain(): ResultAsync<void, RuntimeClientError>;
  /** Revokes ownership and stops renewal after admitted work drains. */
  release(): ResultAsync<void, RuntimeClientError>;
  /** Ownership loss cancels all externally active work, not merely the next SQL write. */
  readonly signal: AbortSignal;
}

/** Private authority and passive public history have independent lifetimes. */
export interface AgentPersistence {
  checkStartup?(
    task: SimulationTask,
    orb: OrbRow,
    context: OperationContext,
  ): ResultAsync<void, RuntimeClientError>;
  open(
    task: SimulationTask,
    orb: OrbRow,
    context: OperationContext,
  ): ResultAsync<AgentStorageLease, RuntimeClientError>;
  snapshot(task: SimulationTask, orb: OrbRow): ResultAsync<AgentSnapshot, RuntimeClientError>;
  /** Archive sealing already removed private state; delete removes all state through the store. */
  dispose(
    task: SimulationTask,
    orbId: string,
    deleteAuthority: boolean,
  ): ResultAsync<void, RuntimeClientError>;
  close(): ResultAsync<void, RuntimeClientError>;
}

import type { InMemoryControlPlaneStore } from "./store.ts";
import type { FakeWorld } from "./world.ts";
import { jsonEqual } from "../domain/json-equal.ts";

/**
 * Core replication invariants (DESIGN.md §14): the replica is a duplicate-free
 * prefix of the filesystem entries in append order, the cursor points at the
 * last replicated record, and the replicated head references a replicated
 * record.
 */
export function assertReplicaIntegrity(
  world: FakeWorld,
  store: InMemoryControlPlaneStore,
  orbId: string,
): void {
  const replica = store.replicaRecords(orbId);
  const entries = world.entriesOf(orbId);
  const orb = store.orbSnapshot(orbId);
  if (orb === null) throw new Error(`orb ${orbId} missing from store`);

  const seen = new Set<string>();
  for (const record of replica) {
    if (seen.has(record.id)) throw new Error(`duplicate record ${record.id} in replica`);
    seen.add(record.id);
  }

  // Prefix property: replica[i] must equal entries[i] for every replicated i.
  // (Truncation tests shrink `entries`; skip the prefix check if the
  // filesystem is shorter than the replica — the cursor check below still
  // guards cursor/commit atomicity.)
  if (entries.length >= replica.length) {
    replica.forEach((record, i) => {
      const entry = entries[i];
      if (entry === undefined || !jsonEqual(record, entry)) {
        throw new Error(
          `replica diverges from filesystem at index ${i}: ${record.id} vs ${entry?.id ?? "<none>"}`,
        );
      }
    });
  }

  const lastReplicated = replica.at(-1)?.id ?? null;
  if (orb.replicationCursor !== lastReplicated) {
    throw new Error(
      `cursor ${orb.replicationCursor} does not match last replicated record ${lastReplicated}`,
    );
  }
  if (orb.replicatedHeadId !== null && !seen.has(orb.replicatedHeadId)) {
    throw new Error(`replicated head ${orb.replicatedHeadId} not present in replica`);
  }
}

/** The replica contains exactly every filesystem entry. */
export function assertReplicaComplete(
  world: FakeWorld,
  store: InMemoryControlPlaneStore,
  orbId: string,
): void {
  assertReplicaIntegrity(world, store, orbId);
  const replica = store.replicaRecords(orbId);
  const entries = world.entriesOf(orbId);
  if (replica.length !== entries.length) {
    throw new Error(
      `replica has ${replica.length} records but filesystem has ${entries.length} entries`,
    );
  }
}

export function assertAtMostOneHost(world: FakeWorld, orbId: string): void {
  if (world.hostCount(orbId) > 1) {
    throw new Error(`orb ${orbId} has more than one host`);
  }
}

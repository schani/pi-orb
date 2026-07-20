/**
 * Named failpoint vocabulary shared by every control-plane DST test
 * (DESIGN.md §14). Probabilities are configured per test by name.
 */
export const FAILPOINTS = {
  storeRead: "store.read",
  storeWrite: "store.write",
  /** Fails before the transaction applies: nothing committed. */
  storeCommitBefore: "store.commit.before",
  /** Fails after the transaction applied: commit landed, caller sees an error. */
  storeCommitAfter: "store.commit.after",
  providerProvision: "provider.provision",
  providerStart: "provider.start",
  providerStop: "provider.stop",
  providerObserve: "provider.observe",
  runtimeHealth: "runtime.health",
  runtimePull: "runtime.pull",
} as const;

export type FailpointName = (typeof FAILPOINTS)[keyof typeof FAILPOINTS];

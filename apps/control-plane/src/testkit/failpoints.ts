/**
 * Named failpoint vocabulary shared by every control-plane DST test
 * (docs/testing.md). Probabilities are configured per test by name.
 */
export const FAILPOINTS = {
  storeRead: "store.read",
  storeWrite: "store.write",
  /** Fails before the transaction applies: nothing committed. */
  storeCommitBefore: "store.commit.before",
  /** Fails after the transaction applied: commit landed, caller sees an error. */
  storeCommitAfter: "store.commit.after",
  /** The one write that clears a queued message's wake intent. */
  storeClearMessageAutoStart: "store.message.clear_auto_start",
  providerProvision: "provider.provision",
  providerStart: "provider.start",
  providerStop: "provider.stop",
  providerDestroy: "provider.destroy",
  providerObserve: "provider.observe",
  runtimeHealth: "runtime.health",
  runtimePull: "runtime.pull",
  /** Inbox delivery, which fails on its own axis from readiness health checks. */
  runtimeDeliverMessage: "runtime.deliver_message",
  brokerPointerRead: "broker.pointer.read",
  /** Fails before the CAS applies: nothing committed. */
  brokerPointerWriteBefore: "broker.pointer.write.before",
  /** Fails after the CAS applied: write landed, caller sees an error. */
  brokerPointerWriteAfter: "broker.pointer.write.after",
  brokerSecretRead: "broker.secret.read",
  brokerSecretWrite: "broker.secret.write",
  githubDeviceCode: "github.device.code",
  githubDevicePoll: "github.device.poll",
} as const;

export type FailpointName = (typeof FAILPOINTS)[keyof typeof FAILPOINTS];

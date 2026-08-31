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
  storeDiscardStatus: "compute-replacement.store.discard-status",
  storeDiscardFinalize: "compute-replacement.store.discard-finalize",
  providerProvision: "provider.provision",
  providerStart: "provider.start",
  providerStop: "provider.stop",
  providerDiscard: "compute-replacement.provider.discard",
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
  projectSecretPointerRead: "project-secrets.pointer.read",
  projectSecretPointerWriteBefore: "project-secrets.pointer.write.before",
  projectSecretPointerWriteAfter: "project-secrets.pointer.write.after",
  projectSecretRead: "project-secrets.secret.read",
  projectSecretWrite: "project-secrets.secret.write",
  projectSecretDestroy: "project-secrets.secret.destroy",
  projectSecretList: "project-secrets.secret.list",
  /** Issuer signing-key table: public JWK rows, not the private key material. */
  signingKeyRead: "issuer.signing-key.read",
  signingKeyWrite: "issuer.signing-key.write",
  /** Key generation, which is CPU and entropy rather than storage. */
  signingKeyGenerate: "issuer.signing-key.generate",
  /** The secret store holding issuer private keys; the broker's own is separate. */
  issuerSecretRead: "issuer.secret.read",
  issuerSecretWrite: "issuer.secret.write",
  /** The signing operation itself: key material unavailable or signing failed. */
  signerSign: "signer.sign",
  githubDeviceCode: "github.device.code",
  githubDevicePoll: "github.device.poll",
} as const;

export type FailpointName = (typeof FAILPOINTS)[keyof typeof FAILPOINTS];

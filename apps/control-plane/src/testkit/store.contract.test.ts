import { InMemoryControlPlaneStore } from "./store.ts";
import { signingKeyStoreContractTests, storeSemanticsContractTests } from "./store-contract.ts";
import { FakeSigningKeyStore } from "./workload-identity.ts";

/**
 * The in-memory store is the substrate of every DST claim, so it owes the same
 * CAS/fence semantics as the SQL adapter — asserted here by the *same* contract
 * body, not by a parallel set of tests that could drift from it.
 */
storeSemanticsContractTests("in-memory", async () => ({
  store: new InMemoryControlPlaneStore(),
  close: async () => {},
}));

signingKeyStoreContractTests("in-memory", async () => ({
  keys: new FakeSigningKeyStore(),
  close: async () => {},
}));

import { ownedProjectsContractTests } from "./owned-projects-contract.ts";
import { InMemoryControlPlaneStore } from "./store.ts";

ownedProjectsContractTests("in-memory", async () => ({
  store: new InMemoryControlPlaneStore(0),
  seedUser: async () => undefined,
  close: async () => undefined,
}));

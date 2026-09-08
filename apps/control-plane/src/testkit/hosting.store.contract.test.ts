import { NoSimulationTask } from "determined";
import { expect } from "vitest";
import { hostingStoreContractTests } from "../adapters/pg/hosting.contract.ts";
import { makeHostingHarness } from "./hosting.ts";

const ORB = "00000000-0000-4000-8000-000000000082";
const TOKEN = "runtime-token-hash";
const task = new NoSimulationTask("fake hosting contract", false);

hostingStoreContractTests("deterministic fake", async () => {
  let state: "running" | "archiving" | "deleting" = "running";
  const harness = makeHostingHarness({
    orbId: ORB,
    observeBoundaries: false,
    authority: (orbId) =>
      orbId === ORB
        ? {
            state,
            runtimeTokenHash: TOKEN,
            hostIncarnation: 1,
            hostDiscardThroughIncarnation: null,
          }
        : null,
  });
  return {
    store: harness.deps.store,
    setup: async () => undefined,
    setOrbState: async (next) => {
      state = next;
    },
    eventTypes: async () => [...harness.events()],
    cleanupErrors: async () => [...harness.cleanupErrors()],
    assertDeletionGuard: async () => {
      expect((await harness.deps.store.finishOrbCleanup(task, ORB)).isErr()).toBe(true);
    },
    close: async () => undefined,
  };
});

import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { makeHarness, makeOrbRow, seedRunningOrb } from "../testkit/fixtures.ts";
import { runDst, waitUntil } from "../testkit/sim.ts";
import { agentHealth, agentHistory, suspendAgent } from "./agent-orchestration.ts";
import type { AgentPlane } from "./agent-ports.ts";
import type { RuntimeClientError } from "./errors.ts";
import { requestOrbDeletion } from "./lifecycle.ts";
import { reconcileLoop } from "./loops.ts";

const context = { signal: new AbortController().signal };
const failure: RuntimeClientError = {
  type: "runtime_client_error",
  code: "unreachable",
  message: "authority unavailable",
  retryable: true,
  answered: false,
};

describe("central agent orchestration", () => {
  it("closes and removes central authority before destroying a permanently deleted guest", async () => {
    await runDst({ name: "central-authority-deletion", iterations: 15 }, async (sim) => {
      const harness = makeHarness({ constants: { deletionQuarantineMs: 2_000 } });
      const stop = new AbortController();
      let disposed = false;
      const plane: AgentPlane = {
        placement: "central",
        health: () => errAsync(failure),
        deliverMessage: () => errAsync(failure),
        prepareIdleStop: () => errAsync(failure),
        pullHistory: () => errAsync(failure),
        suspend: () => okAsync(undefined),
        session: () => null,
        close: () => okAsync(undefined),
        dispose: (_task, id, remove) => {
          expect(id).toBe("central-delete");
          expect(remove).toBe(true);
          if (!disposed) expect(harness.world.hostCount(id)).toBeGreaterThan(0);
          disposed = true;
          return okAsync(undefined);
        },
      };
      const deps = { ...harness.deps, agentPlane: plane };
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, "central-delete");
            expect((await requestOrbDeletion(task, deps, "central-delete")).isOk()).toBe(true);
            await waitUntil(
              task,
              "central deleted",
              () => harness.store.orbSnapshot("central-delete") === null,
              { timeoutMs: 120_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk()).toBe(true);
      expect(disposed).toBe(true);
    });
  });
  it("routes by durable orb identity and incarnation, never guest agent transport", async () => {
    await runDst({ name: "central-agent-binding", iterations: 20 }, async (sim) => {
      const harness = makeHarness();
      const orb = makeOrbRow("central", "project", "running", { hostIncarnation: 7 });
      const seen: string[] = [];
      const plane: AgentPlane = {
        placement: "central",
        deliverMessage: () => errAsync(failure),
        prepareIdleStop: () => errAsync(failure),
        dispose: () => okAsync(undefined),
        session: () => null,
        close: () => okAsync(undefined),
        health: (_task, row) => {
          expect(row.id).toBe("central");
          return errAsync(failure).andTee(() => seen.push("unexpected"));
        },
        pullHistory: (_task, row, request) => {
          expect(row.id).toBe("central");
          expect(request.after).toBe("cursor");
          seen.push("central-history");
          return errAsync(failure);
        },
        suspend: (_task, id) => {
          expect(id).toBe("central");
          return okAsync(undefined).andThen(() => {
            seen.push("suspended");
            return okAsync(undefined);
          });
        },
      };
      const deps = { ...harness.deps, agentPlane: plane };
      const result = await sim.runTasks([
        {
          name: "driver",
          f: async (task) => {
            expect((await agentHealth(task, deps, orb, "http://guest", context)).isErr()).toBe(
              true,
            );
            await task.checkpoint("central health rejected");
            expect(
              (
                await agentHistory(
                  task,
                  deps,
                  orb,
                  { baseUrl: "http://guest", after: "cursor", limit: 5 },
                  context,
                )
              ).isErr(),
            ).toBe(true);
            expect((await suspendAgent(task, deps, orb.id, context)).isOk()).toBe(true);
          },
        },
      ]);
      expect(result.isOk()).toBe(true);
      expect(seen).toEqual(["central-history", "suspended"]);
    });
  });

  it("leaves remote SDK compositions unchanged and suspension a no-op", async () => {
    await runDst({ name: "remote-agent-routing", iterations: 5 }, async (sim) => {
      const harness = makeHarness();
      const seen: string[] = [];
      const deps = {
        ...harness.deps,
        runtimeClient: {
          ...harness.deps.runtimeClient,
          health: () => {
            seen.push("remote-health");
            return errAsync(failure);
          },
        },
      };
      const result = await sim.runTasks([
        {
          name: "driver",
          f: async (task) => {
            await agentHealth(
              task,
              deps,
              makeOrbRow("remote", "project", "running"),
              "http://remote",
              context,
            );
            expect((await suspendAgent(task, deps, "remote", context)).isOk()).toBe(true);
          },
        },
      ]);
      expect(result.isOk()).toBe(true);
      expect(seen).toEqual(["remote-health"]);
    });
  });
});

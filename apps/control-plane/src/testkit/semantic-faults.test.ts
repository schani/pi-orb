import type { SimulationTask } from "determined";
import type { ResultAsync } from "neverthrow";
import { expect, it } from "vitest";
import type { StoreError } from "../domain/errors.ts";
import { makeHarness, seedRunningOrb } from "./fixtures.ts";
import { runDst } from "./sim.ts";
import { InMemoryControlPlaneStore, STORE_OPERATIONS, type StoreOperation } from "./store.ts";

it("each advertised store operation supports persistent, replaceable typed faults", async () => {
  await runDst({ name: "store-operation-faults", iterations: 1, seed: 0 }, async (sim) => {
    const result = await sim.runTasks([
      {
        name: "fault contract",
        f: async (task) => {
          const store = new InMemoryControlPlaneStore();
          for (const operation of Object.keys(STORE_OPERATIONS) as StoreOperation[]) {
            for (const code of ["invariant", "unavailable"] as const) {
              const fault: StoreError = {
                type: "store_error",
                code,
                retryable: code === "unavailable",
                message: operation,
              };
              store.setOperationFault(operation, fault);
              // Faults occur before argument use or mutation on every real port method.
              const invoke = store[operation] as (
                task: SimulationTask,
              ) => ResultAsync<unknown, unknown>;
              for (let attempt = 0; attempt < 2; attempt++) {
                const outcome = await invoke.call(store, task);
                expect(outcome.isErr() && outcome.error).toEqual(fault);
              }
            }
            store.setOperationFault(operation, null);
          }
          expect((await store.getOrb(task, "absent")).isOk()).toBe(true);
          store.failWithInvariant("getOrb");
          expect((await store.getOrb(task, "absent")).isErr()).toBe(true);
          store.clearOperationFaults();
          expect((await store.getOrb(task, "absent")).isOk()).toBe(true);
        },
      },
    ]);
    expect(result.isOk(), result.isErr() ? result.error.stack : "").toBe(true);
  });
});

it("answered execution health is independent of provider state, activity and reachability", async () => {
  await runDst({ name: "execution-health-dimensions", iterations: 1, seed: 0 }, async (sim) => {
    const result = await sim.runTasks([
      {
        name: "health contract",
        f: async (task) => {
          const h = makeHarness();
          const id = "orb";
          seedRunningOrb(task, h, id);
          const url = `http://${h.store.orbSnapshot(id)?.hostRef}:8080`;
          const context = { signal: new AbortController().signal };
          h.world.setActivity(id, "busy");
          h.world.setHealth(id, {
            status: "failed",
            error: { code: "execution_failed", message: "failure", retryable: true },
          });
          const failed = await h.deps.runtimeClient.health(task, url, context);
          expect(failed.isOk() && failed.value.status).toBe("failed");
          expect(h.world.hostStateOf(id)).toBe("running");
          h.world.setRuntimeUnreachable(task, id, 1_000);
          const unreachable = await h.deps.runtimeClient.health(task, url, context);
          expect(unreachable.isErr() && unreachable.error.answered).toBe(false);
          h.world.setRuntimeUnreachable(task, id, 0);
          h.world.setHealth(id, {
            type: "runtime_client_error",
            code: "invalid_response",
            message: "malformed health",
            answered: true,
            retryable: true,
          });
          const malformed = await h.deps.runtimeClient.health(task, url, context);
          expect(malformed.isErr() && malformed.error.answered).toBe(true);
          h.world.setHealth(id, null);
          const ready = await h.deps.runtimeClient.health(task, url, context);
          expect(ready.isOk() && ready.value.status === "ready" && ready.value.activity).toBe(
            "busy",
          );
        },
      },
    ]);
    expect(result.isOk(), result.isErr() ? result.error.stack : "").toBe(true);
  });
});

import { okAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { makeHarness, makeOrbRow } from "../testkit/fixtures.ts";
import { runDst, waitUntil } from "../testkit/sim.ts";
import { awaitExecutionBinding } from "./execution-admission.ts";

describe("execution readiness schedules", () => {
  it.each(["operation_cancel", "stop_start_aba"] as const)(
    "fences %s against late readiness",
    async (mode) => {
      await runDst({ name: `execution-readiness-${mode}`, iterations: 25 }, async (sim) => {
        const harness = makeHarness();
        const orb = makeOrbRow("orb", "project", "starting", {
          hostRef: "host",
          hostIncarnation: 1,
        });
        harness.store.seedOrb(orb);
        const abort = new AbortController();
        let waiting = false;
        let bindings = 0;
        const deps = {
          ...harness.deps,
          hostProvider: {
            ...harness.deps.hostProvider,
            executionBinding: () => {
              bindings++;
              return okAsync({
                baseUrl: "http://guest",
                token: "private",
                incarnation: "2",
                cwd: "/repo",
              });
            },
          },
        };
        const result = await sim.runTasks([
          {
            name: "waiting-tool",
            f: async (task) => {
              const acquired = await awaitExecutionBinding(
                task,
                deps,
                orb.id,
                { signal: abort.signal },
                orb.agentAdmissionVersion,
                () => {
                  waiting = true;
                  return okAsync(undefined);
                },
              );
              expect(acquired.isErr()).toBe(true);
              if (acquired.isErr()) expect(acquired.error.code).toBe("cancelled");
            },
          },
          {
            name: "late-ready",
            f: async (task) => {
              await waitUntil(task, "tool wait published", () => waiting);
              if (mode === "operation_cancel") abort.abort();
              else
                harness.store.seedOrb({
                  ...orb,
                  state: "stopped",
                  stopReason: "manual",
                  agentAdmissionVersion: orb.agentAdmissionVersion + 1,
                });
              await task.checkpoint("stop-before-late-ready");
              harness.store.seedOrb({
                ...orb,
                state: "running",
                hostIncarnation: 2,
                agentAdmissionVersion:
                  mode === "stop_start_aba"
                    ? orb.agentAdmissionVersion + 2
                    : orb.agentAdmissionVersion,
              });
            },
          },
        ]);
        expect(result.isOk()).toBe(true);
        expect(bindings).toBe(0);
      });
    },
  );
  it("waits through an idle compute stop and captures the next immutable binding", async () => {
    await runDst({ name: "execution-readiness-idle-stop", iterations: 25 }, async (sim) => {
      const harness = makeHarness();
      const orb = makeOrbRow("orb", "project", "stopping", {
        stopReason: "idle",
        hostRef: "host",
        hostIncarnation: 1,
      });
      harness.store.seedOrb(orb);
      let waiting = false;
      const deps = {
        ...harness.deps,
        hostProvider: {
          ...harness.deps.hostProvider,
          executionBinding: () =>
            okAsync({
              baseUrl: "http://guest-2",
              token: "private",
              incarnation: "2",
              cwd: "/repo",
            }),
        },
      };
      const result = await sim.runTasks([
        {
          name: "waiting-tool",
          f: async (task) => {
            const acquired = await awaitExecutionBinding(
              task,
              deps,
              orb.id,
              { signal: new AbortController().signal },
              orb.agentAdmissionVersion,
              () => {
                waiting = true;
                return okAsync(undefined);
              },
            );
            expect(acquired._unsafeUnwrap().incarnation).toBe("2");
          },
        },
        {
          name: "idle-completion",
          f: async (task) => {
            await waitUntil(task, "tool waits for idle stop", () => waiting);
            harness.store.seedOrb({ ...orb, state: "stopped" });
            await task.checkpoint("idle-completed");
            harness.store.seedOrb({
              ...orb,
              state: "running",
              stopReason: null,
              hostIncarnation: 2,
            });
          },
        },
      ]);
      expect(result.isOk()).toBe(true);
    });
  });
});

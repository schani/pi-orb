import { ResultAsync } from "neverthrow";
import { expect, it } from "vitest";
import { runDst } from "../testkit/sim.ts";
import { type BootIdentity, planBootNotification } from "./boot-notification.ts";

it("boot delivery crash windows preserve context and bound automatic turns", async () => {
  await runDst(
    {
      name: "boot-notification-crash-windows",
      iterations: 80,
      failpointProbabilities: { "boot.crash-before-append": 0.3, "boot.crash-after-append": 0.3 },
    },
    async (sim) => {
      const run = await sim.runTasks([
        {
          name: "boots",
          f: async (task) => {
            const entries: unknown[] = [
              {
                type: "custom",
                customType: "pi-orb.boot",
                data: { runtimeInstanceId: "r0", executionId: "e0", incarnation: "0" },
              },
              { type: "message", id: "u", message: { role: "user" } },
              {
                type: "message",
                id: "a",
                message: { role: "assistant", stopReason: "stop", content: [] },
              },
            ];
            let automaticTurns = 0;
            for (let index = 1; index <= 8; index++) {
              const identity: BootIdentity = {
                runtimeInstanceId: `r${index}`,
                executionId: `e${index}`,
                incarnation: "0",
              };
              await task.checkpoint("boot.identity-read");
              const plan = planBootNotification(entries, entries, identity);
              expect(plan.kind).toBe("message");
              if (plan.kind !== "message") throw new Error("expected restart notice");
              await task.checkpoint("boot.before-append");
              // A failed append consumes no durable delivery/trigger budget.
              if (
                index < 8 &&
                (
                  await ResultAsync.fromPromise(task.failpoint("boot.crash-before-append"), () => ({
                    type: "injected_crash" as const,
                  }))
                ).isErr()
              )
                continue;
              entries.push({ type: "custom_message", id: `m${index}`, ...plan.marker });
              expect(planBootNotification(entries, entries, identity).kind).toBe("none");
              await task.checkpoint("boot.after-append-before-trigger");
              if (
                (
                  await ResultAsync.fromPromise(task.failpoint("boot.crash-after-append"), () => ({
                    type: "injected_crash" as const,
                  }))
                ).isErr()
              )
                continue;
              if (plan.triggerTurn) automaticTurns++;
              // No assistant result: the next boot must decline rather than loop.
              await task.checkpoint("boot.after-trigger");
            }
            expect(automaticTurns).toBeLessThanOrEqual(1);
            expect(
              entries.some(
                (entry) =>
                  (entry as { customType?: string }).customType === "pi-orb.host-restarted",
              ),
            ).toBe(true);
          },
        },
      ]);
      if (run.isErr()) throw run.error;
    },
  );
});

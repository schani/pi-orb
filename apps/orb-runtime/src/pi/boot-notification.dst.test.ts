import { ResultAsync } from "neverthrow";
import { expect, it } from "vitest";
import { runDst } from "../testkit/sim.ts";
import { type BootIdentity, planBootNotification } from "./boot-notification.ts";
import { mapPiEntry } from "./mapping.ts";

it("generic and sleep boot crash windows preserve context and bound automatic turns", async () => {
  await runDst(
    {
      name: "boot-notification-crash-windows",
      iterations: 80,
      failpointProbabilities: { "boot.crash-before-append": 0.3, "boot.crash-after-append": 0.3 },
    },
    async (sim) => {
      for (const withSleep of [false, true]) {
        const run = await sim.runTasks([
          {
            name: withSleep ? "sleep-boots" : "generic-boots",
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
              const wake = withSleep
                ? {
                    messageId: "sleep-1",
                    messageIds: ["sleep-1"],
                    content: [
                      { type: "text" as const, text: "Sleep ended at its scheduled deadline." },
                    ],
                    system: {
                      kind: "sleep_wake" as const,
                      sleepUntil: "2026-09-18T04:05:06.000Z",
                    },
                  }
                : null;
              let replicated = !withSleep;
              let automaticTurns = 0;
              for (let index = 1; index <= 8; index++) {
                const identity: BootIdentity = {
                  runtimeInstanceId: `${withSleep ? "s" : "g"}r${index}`,
                  executionId: `e${index}`,
                  incarnation: "0",
                };
                await task.checkpoint("boot.identity-read");
                let plan = planBootNotification(
                  entries,
                  entries,
                  identity,
                  replicated ? null : wake,
                );
                if (plan.kind === "none" && !replicated && wake !== null) {
                  // The combined record reached local disk before the runtime crashed,
                  // while the inbox still awaits replication. It suppresses duplicate
                  // delivery; replication then retires the pending context.
                  const combined = entries.findLast(
                    (entry) =>
                      (entry as { customType?: string }).customType === "pi-orb.sleep-wake",
                  );
                  expect(combined).toBeDefined();
                  expect(mapPiEntry(combined)._unsafeUnwrap()).toMatchObject({
                    type: "event",
                    inboxMessageIds: ["sleep-1"],
                  });
                  replicated = true;
                  plan = planBootNotification(entries, entries, identity, null);
                }
                expect(plan.kind).toBe("message");
                if (plan.kind !== "message") throw new Error("expected restart notice");
                await task.checkpoint("boot.before-append");
                if (
                  index < 8 &&
                  (
                    await ResultAsync.fromPromise(
                      task.failpoint("boot.crash-before-append"),
                      () => ({ type: "injected_crash" as const }),
                    )
                  ).isErr()
                )
                  continue;
                const native = {
                  type: "custom_message",
                  id: `${withSleep ? "s" : "g"}m${index}`,
                  parentId: index === 1 ? "a" : `${withSleep ? "s" : "g"}m${index - 1}`,
                  timestamp: `2026-09-18T04:05:0${index}.000Z`,
                  ...plan.marker,
                };
                entries.push(native);
                expect(
                  planBootNotification(entries, entries, identity, replicated ? null : wake).kind,
                ).toBe("none");
                await task.checkpoint("boot.after-append-before-trigger");
                if (
                  (
                    await ResultAsync.fromPromise(
                      task.failpoint("boot.crash-after-append"),
                      () => ({ type: "injected_crash" as const }),
                    )
                  ).isErr()
                )
                  continue;
                if (plan.marker.customType === "pi-orb.sleep-wake") {
                  expect(mapPiEntry(native)._unsafeUnwrap()).toMatchObject({
                    type: "event",
                    inboxMessageIds: ["sleep-1"],
                  });
                  replicated = true;
                }
                if (plan.triggerTurn) automaticTurns++;
                await task.checkpoint("boot.after-trigger");
              }
              expect(automaticTurns).toBeLessThanOrEqual(1);
              if (withSleep) {
                expect(
                  entries.filter(
                    (entry) =>
                      (entry as { customType?: string }).customType === "pi-orb.sleep-wake",
                  ),
                ).toHaveLength(1);
                expect(replicated).toBe(true);
              } else {
                expect(
                  entries.some(
                    (entry) =>
                      (entry as { customType?: string }).customType === "pi-orb.host-restarted",
                  ),
                ).toBe(true);
              }
            },
          },
        ]);
        if (run.isErr()) throw run.error;
      }
    },
  );
});

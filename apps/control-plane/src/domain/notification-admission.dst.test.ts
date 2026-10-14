import { okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow } from "../testkit/fixtures.ts";
import { runDst } from "../testkit/sim.ts";
import { createCentralOrbAgentOperations } from "./orb-agent-operations.ts";

it("checks the trusted central caller for private notification admission without appending a public alert", async () => {
  await runDst({ name: "private-notification-caller", iterations: 10 }, async (sim) => {
    const h = makeHarness();
    h.store.seedProject({ ...makeProjectRow("project"), ownerUserId: "owner" });
    h.store.seedOrb(makeOrbRow("orb", "project", "running"));
    let alerts = 0;
    const results = await sim.runTasks([
      {
        name: "notify",
        f: async (task) => {
          const service = createCentralOrbAgentOperations(
            task,
            h.deps,
            {
              ownerUserId: "owner",
              projectId: "project",
              orbId: "orb",
              agentAdmissionVersion: 0,
            },
            {
              appOrigin: "http://app",
              appendAlert: () => {
                alerts++;
                return okAsync({ recordId: "public" });
              },
            },
          );
          expect((await service.invoke({ kind: "notification_admission" }, "call")).isOk()).toBe(
            true,
          );
          expect(alerts).toBe(0);
        },
      },
    ]);
    expect(results.isOk(), JSON.stringify(results)).toBe(true);
  });
});

it.each(["manual", "sleep", "superseded"] as const)(
  "denies a private notification after %s before native submission",
  async (reason) => {
    await runDst({ name: `private-notification-denied-${reason}`, iterations: 10 }, async (sim) => {
      const h = makeHarness();
      h.store.seedProject({ ...makeProjectRow("project"), ownerUserId: "owner" });
      h.store.seedOrb(
        makeOrbRow("orb", "project", "running", {
          ...(reason === "superseded" ? { agentAdmissionVersion: 1 } : { stopReason: reason }),
        }),
      );
      let alerts = 0;
      const results = await sim.runTasks([
        {
          name: "notify",
          f: async (task) => {
            const service = createCentralOrbAgentOperations(
              task,
              h.deps,
              {
                ownerUserId: "owner",
                projectId: "project",
                orbId: "orb",
                agentAdmissionVersion: 0,
              },
              {
                appOrigin: "http://app",
                appendAlert: () => {
                  alerts++;
                  return okAsync({ recordId: "public" });
                },
              },
            );
            expect((await service.invoke({ kind: "notification_admission" }, "call")).isErr()).toBe(
              true,
            );
            expect(alerts).toBe(0);
          },
        },
      ]);
      expect(results.isOk(), JSON.stringify(results)).toBe(true);
    });
  },
);

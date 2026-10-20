import { NoSimulationTask } from "determined";
import { expect, it } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow } from "../testkit/fixtures.ts";
import { LogCapture, runDst } from "../testkit/sim.ts";
import type { OrbRow } from "./orb.ts";
import { sendOrbMessage } from "./orb-messaging.ts";

function peerOrb(
  id: string,
  state: OrbRow["state"],
  overrides: Partial<OrbRow> = {},
  projectId = sender.projectId,
): OrbRow {
  return makeOrbRow(id, projectId, state, overrides);
}

function seed() {
  const h = makeHarness();
  h.store.seedProject({ ...makeProjectRow(sender.projectId), ownerUserId: sender.ownerUserId });
  h.store.seedOrb(peerOrb(sender.orbId, "running", { ...sender.caller, hostRef: "host" }));
  h.store.seedOrb(peerOrb(request.orbId, "stopped", { stopReason: "manual" }));
  return h;
}
const sender = {
  orbId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000010",
  ownerUserId: "00000000-0000-4000-8000-000000000011",
  caller: { runtimeTokenHash: "token", hostIncarnation: 1 },
};
const request = {
  orbId: "00000000-0000-4000-8000-000000000002",
  message: "secret message text",
  messageId: "00000000-0000-4000-8000-000000000013",
};

it("emits one content-free acceptance edge across lost acknowledgements and retries", async () => {
  const logs = new LogCapture();
  await runDst({ name: "peer-send-lost-ack", iterations: 10, logCapture: logs }, async (sim) => {
    const h = seed();
    const result = await sim.runTasks([
      {
        name: "sender",
        f: async (task) => {
          expect((await sendOrbMessage(task, h.deps, sender, request)).isOk()).toBe(true);
          expect((await sendOrbMessage(task, h.deps, sender, request)).isOk()).toBe(true);
          const target = h.store.orbSnapshot(request.orbId);
          expect(target).toBeDefined();
          if (!target) return;
          expect(
            (
              await h.store.requestOrbStop(task, {
                orbId: request.orbId,
                expectedStateVersion: target.stateVersion,
                now: task.wallNow(),
              })
            ).isOk(),
          ).toBe(true);
          expect((await sendOrbMessage(task, h.deps, sender, request)).isOk()).toBe(true);
          expect(h.store.orbSnapshot(request.orbId)?.stopReason).toBe("manual");
          expect(h.store.messageSnapshots(request.orbId)[0]?.autoStart).toBe(false);
        },
      },
    ]);
    expect(result.isOk()).toBe(true);
    expect(logs.matching("message-accepted")).toHaveLength(1);
    expect(logs.lines().join("\n")).not.toContain(request.message);
    expect(logs.lines().join("\n")).toContain(
      "sender=00000000-0000-4000-8000-000000000001 message=00000000-0000-4000-8000-000000000013",
    );
  });
});

it("accepts same-owner cross-project targets and rejects missing or foreign-owner targets", async () => {
  const h = seed();
  const task = new NoSimulationTask("peer scopes", false);
  h.store.seedProject({
    ...makeProjectRow("00000000-0000-4000-8000-000000000012"),
    ownerUserId: sender.ownerUserId,
  });
  h.store.seedOrb(
    peerOrb(
      "00000000-0000-4000-8000-000000000003",
      "running",
      {},
      "00000000-0000-4000-8000-000000000012",
    ),
  );
  expect(
    (
      await sendOrbMessage(task, h.deps, sender, {
        ...request,
        orbId: "00000000-0000-4000-8000-000000000004",
      })
    )._unsafeUnwrapErr().code,
  ).toBe("not_found");
  expect(
    (await sendOrbMessage(task, h.deps, sender, { ...request, orbId: "bad" }))._unsafeUnwrapErr()
      .code,
  ).toBe("invalid_request");
  const crossProject = { ...request, orbId: "00000000-0000-4000-8000-000000000003" };
  expect((await sendOrbMessage(task, h.deps, sender, crossProject)).isOk()).toBe(true);
  expect((await sendOrbMessage(task, h.deps, sender, crossProject)).isOk()).toBe(true);
  expect(h.store.messageSnapshots(crossProject.orbId)).toMatchObject([
    { system: { kind: "orb_message", senderOrbId: sender.orbId } },
  ]);
  h.store.seedProject({
    ...makeProjectRow("00000000-0000-4000-8000-000000000012"),
    ownerUserId: "00000000-0000-4000-8000-000000000099",
  });
  expect((await sendOrbMessage(task, h.deps, sender, crossProject))._unsafeUnwrapErr().code).toBe(
    "conflict",
  );
  expect(h.store.messageSnapshots(crossProject.orbId)).toHaveLength(1);
});

it.each(["sender", "target"] as const)(
  "orders reciprocal cross-project sends against %s project deletion",
  async (side) => {
    await runDst(
      { name: `cross-project-peer-delete-${side}`, iterations: 60, seed: 71 },
      async (sim) => {
        const h = seed();
        const targetProject = "00000000-0000-4000-8000-000000000012";
        h.store.seedProject({ ...makeProjectRow(targetProject), ownerUserId: sender.ownerUserId });
        h.store.seedOrb(peerOrb(request.orbId, "running", { ...sender.caller }, targetProject));
        const reverseSender = { ...sender, orbId: request.orbId, projectId: targetProject };
        const reverse = { ...request, orbId: sender.orbId };
        const reciprocal = await sim.runTasks([
          {
            name: "forward",
            f: async (task) =>
              expect((await sendOrbMessage(task, h.deps, sender, request)).isOk()).toBe(true),
          },
          {
            name: "reverse",
            f: async (task) =>
              expect((await sendOrbMessage(task, h.deps, reverseSender, reverse)).isOk()).toBe(
                true,
              ),
          },
        ]);
        expect(reciprocal.isOk()).toBe(true);
        const freshId = "00000000-0000-4000-8000-000000000014";
        const race = await sim.runTasks([
          {
            name: "admit",
            f: async (task) => {
              const result = await sendOrbMessage(task, h.deps, sender, {
                ...request,
                messageId: freshId,
              });
              expect(
                h.store.messageSnapshots(request.orbId).some((m) => m.messageId === freshId),
              ).toBe(result.isOk());
            },
          },
          {
            name: "delete",
            f: async (task) => {
              expect(
                (
                  await h.store.requestProjectDeletion(task, {
                    projectId: side === "sender" ? sender.projectId : targetProject,
                    now: task.wallNow(),
                    cleanupAfter: task.wallNow(),
                  })
                ).isOk(),
              ).toBe(true);
              for (const [source, message] of [
                [sender, request],
                [reverseSender, reverse],
              ] as const)
                expect(
                  (await sendOrbMessage(task, h.deps, source, message))._unsafeUnwrapErr().code,
                ).toBe("conflict");
            },
          },
        ]);
        expect(race.isOk()).toBe(true);
      },
    );
  },
);

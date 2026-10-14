import { NoSimulationTask } from "determined";
import { expect, it } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow } from "../testkit/fixtures.ts";
import { LogCapture, runDst } from "../testkit/sim.ts";
import { sendOrbMessage } from "./orb-messaging.ts";

function seed() {
  const h = makeHarness();
  h.store.seedProject({
    ...makeProjectRow("00000000-0000-4000-8000-000000000010"),
    ownerUserId: "00000000-0000-4000-8000-000000000011",
  });
  h.store.seedOrb(
    makeOrbRow(
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000010",
      "running",
      {
        runtimeTokenHash: "token",
        hostIncarnation: 1,
        hostRef: "host",
      },
    ),
  );
  h.store.seedOrb(
    makeOrbRow(
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000010",
      "stopped",
      {
        stopReason: "manual",
      },
    ),
  );
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
          const target = h.store.orbSnapshot("00000000-0000-4000-8000-000000000002");
          expect(target).toBeDefined();
          if (!target) return;
          expect(
            (
              await h.store.requestOrbStop(task, {
                orbId: "00000000-0000-4000-8000-000000000002",
                expectedStateVersion: target.stateVersion,
                now: task.wallNow(),
              })
            ).isOk(),
          ).toBe(true);
          expect((await sendOrbMessage(task, h.deps, sender, request)).isOk()).toBe(true);
          expect(h.store.orbSnapshot("00000000-0000-4000-8000-000000000002")?.stopReason).toBe(
            "manual",
          );
          expect(
            h.store.messageSnapshots("00000000-0000-4000-8000-000000000002")[0]?.autoStart,
          ).toBe(false);
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

it.each([
  "stop",
  "replace",
  "discard",
  "archive",
  "delete",
  "project",
  "central-stop-start",
] as const)("fences send and retry against concurrent sender %s", async (mutation) => {
  await runDst({ name: `peer-send-${mutation}`, iterations: 20 }, async (sim) => {
    const h = seed();
    const authority =
      mutation === "central-stop-start"
        ? {
            ...sender,
            caller: {
              kind: "central" as const,
              orbId: sender.orbId,
              ownerUserId: sender.ownerUserId,
              projectId: sender.projectId,
              agentAdmissionVersion: 0,
            },
          }
        : sender;
    let sendAccepted: boolean | undefined;
    let acceptedBeforeRevocation: boolean | undefined;
    const result = await sim.runTasks([
      {
        name: "send",
        f: async (task) => {
          sendAccepted = (await sendOrbMessage(task, h.deps, authority, request)).isOk();
        },
      },
      {
        name: "revoke",
        f: async (task) => {
          switch (mutation) {
            case "central-stop-start": {
              const stopped = (
                await h.store.requestOrbStop(task, {
                  orbId: sender.orbId,
                  expectedStateVersion: 0,
                  now: task.wallNow(),
                })
              )._unsafeUnwrap().orb;
              acceptedBeforeRevocation = h.store.messageSnapshots(request.orbId).length === 1;
              (
                await h.store.casTransition(task, {
                  orbId: sender.orbId,
                  expectedStateVersion: stopped.stateVersion,
                  toState: "starting",
                  stopReason: null,
                  cancelSleep: true,
                  now: task.wallNow(),
                })
              )._unsafeUnwrap();
              break;
            }
            case "stop":
              (
                await h.store.requestOrbStop(task, {
                  orbId: "00000000-0000-4000-8000-000000000001",
                  expectedStateVersion: 0,
                  now: task.wallNow(),
                })
              )._unsafeUnwrap();
              break;
            case "replace":
              (
                await h.store.casUpdateFields(task, {
                  orbId: "00000000-0000-4000-8000-000000000001",
                  expectedStateVersion: 0,
                  now: task.wallNow(),
                  runtimeTokenHash: "new-token",
                })
              )._unsafeUnwrap();
              break;
            case "discard":
              (
                await h.store.requestHostSpecReplacement(task, {
                  orbId: "00000000-0000-4000-8000-000000000001",
                  expectedStateVersion: 0,
                  desiredFingerprint: "00000000-0000-4000-8000-000000000014",
                  configuredGeneration: 1,
                  force: true,
                  now: task.wallNow(),
                })
              )._unsafeUnwrap();
              break;
            case "archive":
              (
                await h.store.requestOrbArchive(task, {
                  orbId: "00000000-0000-4000-8000-000000000001",
                  expectedStateVersion: 0,
                  now: task.wallNow(),
                  cleanupAfter: task.wallNow(),
                })
              )._unsafeUnwrap();
              break;
            case "delete":
              (
                await h.store.requestOrbDeletion(task, {
                  orbId: "00000000-0000-4000-8000-000000000001",
                  expectedStateVersion: 0,
                  now: task.wallNow(),
                  cleanupAfter: task.wallNow(),
                })
              )._unsafeUnwrap();
              break;
            case "project":
              (
                await h.store.requestProjectDeletion(task, {
                  projectId: "00000000-0000-4000-8000-000000000010",
                  now: task.wallNow(),
                  cleanupAfter: task.wallNow(),
                })
              )._unsafeUnwrap();
              break;
          }
          acceptedBeforeRevocation ??= h.store.messageSnapshots(request.orbId).length === 1;
          expect((await sendOrbMessage(task, h.deps, authority, request)).isErr()).toBe(true);
          expect(
            (
              await sendOrbMessage(task, h.deps, authority, {
                ...request,
                messageId: "00000000-0000-4000-8000-000000000014",
              })
            ).isErr(),
          ).toBe(true);
        },
      },
    ]);
    expect(result.isOk(), JSON.stringify(result)).toBe(true);
    expect(sendAccepted).toBe(acceptedBeforeRevocation);
    expect(h.store.messageSnapshots(request.orbId)).toHaveLength(sendAccepted ? 1 : 0);
  });
});

it("rejects cross-project and unavailable targets and wakes eligible stopped/failed targets", async () => {
  const h = seed();
  const task = new NoSimulationTask("peer scopes", false);
  h.store.seedProject({
    ...makeProjectRow("00000000-0000-4000-8000-000000000012"),
    ownerUserId: "00000000-0000-4000-8000-000000000011",
  });
  h.store.seedOrb(
    makeOrbRow(
      "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000012",
      "running",
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
  for (const id of ["00000000-0000-4000-8000-000000000004", "00000000-0000-4000-8000-000000000003"])
    expect((await sendOrbMessage(task, h.deps, sender, { ...request, orbId: id })).isErr()).toBe(
      true,
    );
  for (const state of ["archiving", "archived", "deleting"] as const) {
    h.store.seedOrb(
      makeOrbRow(
        "00000000-0000-4000-8000-000000000002",
        "00000000-0000-4000-8000-000000000010",
        state,
      ),
    );
    expect((await sendOrbMessage(task, h.deps, sender, request)).isErr()).toBe(true);
  }
  for (const state of ["stopped", "stopping", "failed"] as const) {
    const id = `00000000-0000-4000-8000-00000000000${state === "failed" ? 7 : state === "stopping" ? 6 : 5}`;
    h.store.seedOrb(
      makeOrbRow(id, "00000000-0000-4000-8000-000000000010", state, {
        stopReason: "sleep",
        sleepId: "00000000-0000-4000-8000-000000000015",
        sleepUntil: 5000,
      }),
    );
    const accepted = (
      await sendOrbMessage(task, h.deps, sender, { ...request, orbId: id })
    )._unsafeUnwrap();
    expect(accepted.orbId).toBe(id);
    expect(h.store.orbSnapshot(id)).toMatchObject({
      sleepId: null,
      sleepUntil: null,
      stopReason: null,
    });
    expect(h.store.messageSnapshots(id)[0]).toMatchObject({
      autoStart: true,
      wakeStateVersion: 1,
    });
  }
});

it.each(["stop", "delete"] as const)(
  "orders target %s against send and never replays wake",
  async (mutation) => {
    await runDst({ name: `peer-target-${mutation}`, iterations: 20 }, async (sim) => {
      const h = seed();
      h.store.seedOrb(makeOrbRow(request.orbId, sender.projectId, "running"));
      let sendAccepted: boolean | undefined;
      let sendBeforeFence: boolean | undefined;
      const result = await sim.runTasks([
        {
          name: "send",
          f: async (task) => {
            sendAccepted = (await sendOrbMessage(task, h.deps, sender, request)).isOk();
          },
        },
        {
          name: "target fence",
          f: async (task) => {
            if (mutation === "stop")
              (
                await h.store.requestOrbStop(task, {
                  orbId: request.orbId,
                  expectedStateVersion: 0,
                  now: task.wallNow(),
                })
              )._unsafeUnwrap();
            else
              (
                await h.store.requestOrbDeletion(task, {
                  orbId: request.orbId,
                  expectedStateVersion: 0,
                  now: task.wallNow(),
                  cleanupAfter: task.wallNow(),
                })
              )._unsafeUnwrap();
            sendBeforeFence = h.store.messageSnapshots(request.orbId).length === 1;
          },
        },
      ]);
      expect(result.isOk()).toBe(true);
      expect(sendAccepted).toBe(mutation === "stop" || sendBeforeFence);
      const rows = h.store.messageSnapshots(request.orbId);
      expect(rows).toHaveLength(sendAccepted ? 1 : 0);
      if (mutation === "stop") {
        expect(rows[0]?.autoStart).toBe(!sendBeforeFence);
        expect(h.store.orbSnapshot(request.orbId)?.stopReason).toBe(
          sendBeforeFence ? "manual" : null,
        );
      }
      await sim.runTasks([
        {
          name: "retry",
          f: async (task) => {
            const before = h.store.orbSnapshot(request.orbId);
            const replay = await sendOrbMessage(task, h.deps, sender, request);
            expect(replay.isOk()).toBe(mutation === "stop");
            expect(h.store.orbSnapshot(request.orbId)).toEqual(before);
          },
        },
      ]);
    });
  },
);

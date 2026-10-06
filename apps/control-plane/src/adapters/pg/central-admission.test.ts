import { NoSimulationTask } from "determined";
import { expect, it } from "vitest";
import type { CentralAgentCaller } from "../../domain/ports.ts";
import { makeOrbRow, makeProjectRow, TEST_USER_ID } from "../../testkit/fixtures.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { PGliteClient } from "./pglite-client.ts";

const task = new NoSimulationTask("central admission transaction", false);
const projectId = "00000000-0000-4000-8000-000000000011";
const orbId = "00000000-0000-4000-8000-000000000012";
const childId = "00000000-0000-4000-8000-000000000013";
const caller: CentralAgentCaller = {
  kind: "central",
  ownerUserId: TEST_USER_ID,
  projectId,
  orbId,
  agentAdmissionVersion: 0,
};

it("persists manual inhibition and denies stale central transactions across Stop→Start", async () => {
  const client = new PGliteClient();
  const database = composeControlPlaneDatabase(client);
  try {
    expect((await database.migrate()).isOk()).toBe(true);
    expect(
      (
        await client.query(
          "INSERT INTO users (id, identity_issuer, identity_subject, created_at, updated_at) VALUES ($1, 'test', 'owner', now(), now())",
          [TEST_USER_ID],
        )
      ).isOk(),
    ).toBe(true);
    expect((await database.store.insertProject(task, makeProjectRow(projectId))).isOk()).toBe(true);
    expect(
      (
        await database.store.insertOrb(
          task,
          makeOrbRow(orbId, projectId, "stopped", { stopReason: "idle" }),
        )
      ).isOk(),
    ).toBe(true);
    const stopped = (
      await database.store.requestOrbStop(task, { orbId, expectedStateVersion: 0, now: 1_000 })
    )._unsafeUnwrap().orb;
    expect(stopped.stopReason).toBe("manual");
    expect(stopped.agentAdmissionVersion).toBe(1);
    const started = (
      await database.store.casTransition(task, {
        orbId,
        expectedStateVersion: stopped.stateVersion,
        toState: "starting",
        now: 2_000,
        stopReason: null,
        cancelSleep: true,
      })
    )._unsafeUnwrap();
    expect(started.agentAdmissionVersion).toBe(2);
    expect((await database.store.getOrb(task, orbId))._unsafeUnwrap()?.agentAdmissionVersion).toBe(
      2,
    );
    for (const epoch of [0, 1]) {
      const stale = { ...caller, agentAdmissionVersion: epoch };
      expect(
        (
          await database.store.spawnOrb(task, {
            callerOrbId: orbId,
            caller: stale,
            orb: makeOrbRow(childId, projectId, "creating"),
            prompt: "work",
            requestHash: "hash",
          })
        )._unsafeUnwrapErr(),
      ).toMatchObject({ type: "spawn_conflict", reason: "unauthorized" });
      expect(
        (
          await database.store.scheduleOrbSleep(task, {
            orbId,
            caller: stale,
            sleepId: childId,
            durationSeconds: 60,
          })
        )._unsafeUnwrapErr(),
      ).toMatchObject({ type: "state_conflict" });
      for (const operation of [
        database.store.requestOrbArchive.bind(database.store),
        database.store.requestOrbDeletion.bind(database.store),
      ]) {
        expect(
          (
            await operation(task, {
              orbId,
              caller: stale,
              expectedStateVersion: started.stateVersion,
              now: 3_000,
              cleanupAfter: 3_000,
            })
          )._unsafeUnwrapErr(),
        ).toMatchObject({ type: "state_conflict" });
      }
    }
    expect((await database.store.getOrb(task, childId))._unsafeUnwrap()).toBeNull();
    expect((await database.store.getOrb(task, orbId))._unsafeUnwrap()?.state).toBe("starting");
    const fresh = { ...caller, agentAdmissionVersion: 2 };
    for (const inhibition of ["sleep", "pending"] as const) {
      expect(
        (
          await client.query(
            "UPDATE orbs SET state = 'stopped', stop_reason = $2, sleep_id = $3, sleep_until = $4 WHERE id = $1",
            [
              orbId,
              inhibition === "sleep" ? "sleep" : null,
              inhibition === "pending" ? childId : null,
              inhibition === "pending" ? new Date(60_000) : null,
            ],
          )
        ).isOk(),
      ).toBe(true);
      expect(
        (
          await database.store.spawnOrb(task, {
            callerOrbId: orbId,
            caller: fresh,
            orb: makeOrbRow(childId, projectId, "creating"),
            prompt: "work",
            requestHash: "hash",
          })
        )._unsafeUnwrapErr(),
      ).toMatchObject({ type: "spawn_conflict", reason: "unauthorized" });
      expect(
        (
          await database.store.scheduleOrbSleep(task, {
            orbId,
            caller: fresh,
            sleepId: childId,
            durationSeconds: 60,
          })
        )._unsafeUnwrapErr(),
      ).toMatchObject({ type: "state_conflict" });
      for (const operation of [
        database.store.requestOrbArchive.bind(database.store),
        database.store.requestOrbDeletion.bind(database.store),
      ])
        expect(
          (
            await operation(task, {
              orbId,
              caller: fresh,
              expectedStateVersion: started.stateVersion,
              now: 3_000,
              cleanupAfter: 3_000,
            })
          )._unsafeUnwrapErr(),
        ).toMatchObject({ type: "state_conflict" });
      expect(
        (await database.store.getOrb(task, orbId))._unsafeUnwrap()?.agentAdmissionVersion,
      ).toBe(2);
    }
    expect(
      (
        await client.query(
          "UPDATE orbs SET state = 'starting', stop_reason = NULL, sleep_id = NULL, sleep_until = NULL WHERE id = $1",
          [orbId],
        )
      ).isOk(),
    ).toBe(true);
    const archived = await database.store.requestOrbArchive(task, {
      orbId,
      caller: fresh,
      expectedStateVersion: started.stateVersion,
      now: 4_000,
      cleanupAfter: 4_000,
    });
    expect(archived.isOk(), archived.isErr() ? JSON.stringify(archived.error) : "").toBe(true);
    expect((await database.store.getOrb(task, orbId))._unsafeUnwrap()?.agentAdmissionVersion).toBe(
      2,
    );
  } finally {
    expect((await database.close()).isOk()).toBe(true);
  }
});

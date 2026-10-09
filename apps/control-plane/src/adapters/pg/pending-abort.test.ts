import { NoSimulationTask } from "determined";
import { expect, it } from "vitest";
import { makeOrbRow, makeProjectRow, TEST_USER_ID } from "../../testkit/fixtures.ts";
import { openThrowawayPostgres } from "../../testkit/postgres.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { PGliteClient } from "./pglite-client.ts";

const task = new NoSimulationTask("pending abort", false);
const projectId = "00000000-0000-4000-8000-000000000011";
const orbId = "00000000-0000-4000-8000-000000000012";
const messageId = "00000000-0000-4000-8000-000000000013";
const nextId = "00000000-0000-4000-8000-000000000014";

it("cancels only the named pending turn, retains its visible outcome and fences ABA", async () => {
  const url = process.env["PI_ORB_PENDING_ABORT_TEST_DATABASE_URL"];
  const subject = url
    ? await openThrowawayPostgres(url)
    : (() => {
        const client = new PGliteClient();
        return { client, database: composeControlPlaneDatabase(client) };
      })();
  const { client, database } = subject;
  try {
    (await database.migrate())._unsafeUnwrap();
    (
      await client.query(
        "INSERT INTO users (id, identity_issuer, identity_subject, created_at, updated_at) VALUES ($1, 'test', 'owner', now(), now())",
        [TEST_USER_ID],
      )
    )._unsafeUnwrap();
    (await database.store.insertProject(task, makeProjectRow(projectId)))._unsafeUnwrap();
    (
      await database.store.insertOrb(task, makeOrbRow(orbId, projectId, "starting"))
    )._unsafeUnwrap();
    for (const id of [messageId, nextId])
      (
        await database.store.enqueueOrbMessage(task, {
          orbId,
          messageId: id,
          content: [{ type: "text", text: id }],
          now: 1,
        })
      )._unsafeUnwrap();
    const caller = {
      kind: "central" as const,
      ownerUserId: TEST_USER_ID,
      projectId,
      orbId,
      agentAdmissionVersion: 0,
    };
    const params = { orbId, messageId, caller, now: 2 };
    (
      await client.query(
        "ALTER TABLE orb_messages ADD CONSTRAINT pending_abort_test_failure CHECK (last_error IS DISTINCT FROM 'Cancelled before agent admission')",
      )
    )._unsafeUnwrap();
    expect((await database.store.cancelPendingOrbMessage(task, params)).isErr()).toBe(true);
    expect((await database.store.listOrbMessages(task, orbId))._unsafeUnwrap()[0]).toMatchObject({
      status: "queued",
      lastError: null,
    });
    (
      await client.query("ALTER TABLE orb_messages DROP CONSTRAINT pending_abort_test_failure")
    )._unsafeUnwrap();
    expect((await database.store.cancelPendingOrbMessage(task, params))._unsafeUnwrap()).toBe(
      "cancelled",
    );
    expect((await database.store.cancelPendingOrbMessage(task, params))._unsafeUnwrap()).toBe(
      "cancelled",
    );
    const sameInputRetry = await database.store.enqueueOrbMessage(task, {
      orbId,
      messageId,
      content: [{ type: "text", text: messageId }],
      now: 3,
    });
    expect(sameInputRetry._unsafeUnwrap()).toMatchObject({
      duplicate: true,
      message: { status: "failed" },
    });
    const editedRetry = await database.store.enqueueOrbMessage(task, {
      orbId,
      messageId,
      content: [{ type: "text", text: "edited retry" }],
      now: 3,
    });
    expect(editedRetry._unsafeUnwrapErr()).toMatchObject({ type: "state_conflict" });
    const messages = (await database.store.listOrbMessages(task, orbId))._unsafeUnwrap();
    expect(messages[0]).toMatchObject({
      status: "failed",
      lastError: "Cancelled before agent admission",
      autoStart: false,
    });
    expect(messages[1]).toMatchObject({ status: "queued" });
    expect(
      (await database.store.claimNextOrbMessageBatch(task, { orbId, now: 3 }))
        ._unsafeUnwrap()
        .map((row) => row.messageId),
    ).toEqual([nextId]);
    expect((await database.store.getOrb(task, orbId))._unsafeUnwrap()).toMatchObject({
      state: "starting",
      stopReason: null,
      agentAdmissionVersion: 0,
    });
    (
      await database.store.noteOrbMessageDelivery(task, {
        orbId,
        messageIds: [nextId],
        delivery: "turn",
        operationId: "active",
        now: 4,
      })
    )._unsafeUnwrap();
    expect(
      (
        await database.store.cancelPendingOrbMessage(task, { ...params, messageId: nextId })
      )._unsafeUnwrap(),
    ).toBe("active");
    expect(
      (
        await database.store.cancelPendingOrbMessage(task, {
          ...params,
          caller: { ...caller, ownerUserId: nextId },
        })
      ).isErr(),
    ).toBe(true);
    const stopped = (
      await database.store.requestOrbStop(task, { orbId, expectedStateVersion: 0, now: 5 })
    )._unsafeUnwrap().orb;
    (
      await database.store.casTransition(task, {
        orbId,
        expectedStateVersion: stopped.stateVersion,
        toState: "starting",
        now: 6,
        stopReason: null,
        cancelSleep: true,
      })
    )._unsafeUnwrap();
    expect(
      (await database.store.cancelPendingOrbMessage(task, params))._unsafeUnwrapErr(),
    ).toMatchObject({ type: "state_conflict" });
  } finally {
    (await database.close())._unsafeUnwrap();
  }
});

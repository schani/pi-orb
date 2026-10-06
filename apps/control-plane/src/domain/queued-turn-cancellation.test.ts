import { NoSimulationTask } from "determined";
import { errAsync, okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { cancelQueuedUserTurn } from "./queued-turn-cancellation.ts";

const task = new NoSimulationTask("queued turn cancellation", false);
task.wallNow = () => 1_000;
const caller = {
  kind: "central" as const,
  ownerUserId: "owner",
  projectId: "project",
  orbId: "orb",
  agentAdmissionVersion: 3,
};
const id = "00000000-0000-4000-8000-000000000013";
it("does not acknowledge failed persistence and sanitizes adapter errors", async () => {
  const store = {
    cancelPendingOrbMessage: () =>
      errAsync({
        type: "store_error" as const,
        code: "unavailable" as const,
        retryable: true,
        message: "raw SQL secret",
      }),
  };
  expect(
    (await cancelQueuedUserTurn(task, store, caller, `inbox:${id}`))._unsafeUnwrapErr(),
  ).toMatchObject({
    code: "history_unavailable",
    retryable: true,
    message: "Pending turn cancellation unavailable",
  });
});
it("does not load agent or cancel arbitrary operations and uses exact inbox identity", async () => {
  const calls: unknown[] = [];
  const store = {
    cancelPendingOrbMessage: (_task: unknown, params: unknown) => {
      calls.push(params);
      return okAsync("cancelled" as const);
    },
  };
  expect(
    (await cancelQueuedUserTurn(task, store, caller, "native-operation"))._unsafeUnwrap(),
  ).toBeUndefined();
  expect(
    (await cancelQueuedUserTurn(task, store, caller, "inbox:invalid"))._unsafeUnwrap(),
  ).toBeUndefined();
  expect(calls).toEqual([]);
  expect((await cancelQueuedUserTurn(task, store, caller, `inbox:${id}`))._unsafeUnwrap()).toBe(
    "cancelled",
  );
  expect(calls).toEqual([{ orbId: "orb", messageId: id, caller, now: task.wallNow() }]);
});

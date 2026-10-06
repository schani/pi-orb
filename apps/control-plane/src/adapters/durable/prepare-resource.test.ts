import { NoSimulationTask } from "determined";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { expect, it } from "vitest";
import { makeOrbRow } from "../../testkit/fixtures.ts";
import { DurableAgentPlane, durableError } from "./manager.ts";

it("cancels pending resource preparation promptly on Stop, without acquiring a lease", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let leased = false;
  const plane = (
    await DurableAgentPlane.create({
      persistence: {
        open: () => {
          leased = true;
          return errAsync(durableError("unexpected"));
        },
        snapshot: () => errAsync(durableError("empty")),
        dispose: () => okAsync(undefined),
        close: () => okAsync(undefined),
      },
      prepare: (_task, _orb, context) =>
        ResultAsync.fromSafePromise(
          new Promise<void>((resolve) => {
            entered();
            context.signal.addEventListener("abort", () => resolve(), { once: true });
          }),
        ).andThen(() => errAsync(durableError("cancelled"))),
      openContext: () => errAsync(durableError("unexpected")),
    })
  )._unsafeUnwrap();
  const task = new NoSimulationTask("resource-stop", false);
  const orb = makeOrbRow("orb", "project", "starting");
  const context = { signal: new AbortController().signal };
  const health = plane.health(task, orb, context);
  await started;
  const stopped = plane.suspend(task, orb.id, context, orb.agentAdmissionVersion);
  expect((await stopped).isOk()).toBe(true);
  expect((await health).isErr()).toBe(true);
  expect(leased).toBe(false);
  await plane.close();
});

it("does not acquire ownership or compose models before the required resource snapshot settles", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: string[] = [];
  const plane = (
    await DurableAgentPlane.create({
      persistence: {
        open: () => {
          events.push("lease");
          return errAsync(durableError("test gate complete"));
        },
        snapshot: () => errAsync(durableError("empty")),
        dispose: () => okAsync(undefined),
        close: () => okAsync(undefined),
      },
      prepare: () => {
        events.push("resources");
        return ResultAsync.fromSafePromise(gate);
      },
      openContext: () => {
        events.push("model");
        return errAsync(durableError("unexpected"));
      },
    })
  )._unsafeUnwrap();
  const health = plane.health(
    new NoSimulationTask("resources", false),
    makeOrbRow("orb", "project", "starting"),
    { signal: new AbortController().signal },
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(events).toEqual(["resources"]);
  release();
  expect((await health).isErr()).toBe(true);
  expect(events).toEqual(["resources", "lease"]);
  await plane.close();
});

import { NoSimulationTask } from "determined";
import { okAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { makeHarness, makeOrbRow } from "../testkit/fixtures.ts";
import { awaitExecutionBinding } from "./execution-admission.ts";

it("rechecks admission after immutable binding acquisition", async () => {
  const harness = makeHarness();
  const task = new NoSimulationTask("execution-admission", false);
  const orb = makeOrbRow("orb", "project", "running", { hostRef: "host", hostIncarnation: 3 });
  harness.store.seedOrb(orb);
  const controller = new AbortController();
  const deps = {
    ...harness.deps,
    hostProvider: {
      ...harness.deps.hostProvider,
      executionBinding: () => {
        controller.abort();
        return okAsync({
          baseUrl: "http://guest",
          token: "private",
          incarnation: "3",
          cwd: "/workspace/repo",
        });
      },
    },
  };
  expect(
    (await awaitExecutionBinding(task, deps, orb.id, { signal: controller.signal })).isErr(),
  ).toBe(true);
});

it("holds and releases a VM-only lease around the immutable invocation", async () => {
  const harness = makeHarness();
  const orb = makeOrbRow("orb", "project", "running", { hostRef: "host", hostIncarnation: 3 });
  harness.store.seedOrb(orb);
  const deps = {
    ...harness.deps,
    hostProvider: {
      ...harness.deps.hostProvider,
      executionBinding: () =>
        okAsync({ baseUrl: "http://guest", token: "private", incarnation: "3", cwd: "/repo" }),
    },
  };
  const result = (
    await awaitExecutionBinding(new NoSimulationTask("lease", false), deps, orb.id, {
      signal: new AbortController().signal,
    })
  )._unsafeUnwrap();
  expect(harness.deps.control.hasExecutionLeases(orb.id)).toBe(true);
  result.release();
  result.release();
  expect(harness.deps.control.hasExecutionLeases(orb.id)).toBe(false);
});

it("releases an admitted lease when final lifecycle validation loses", async () => {
  const harness = makeHarness();
  const orb = makeOrbRow("orb", "project", "running", { hostRef: "host", hostIncarnation: 3 });
  harness.store.seedOrb(orb);
  const deps = {
    ...harness.deps,
    hostProvider: {
      ...harness.deps.hostProvider,
      executionBinding: () => {
        harness.store.seedOrb({ ...orb, state: "failed" });
        return okAsync({
          baseUrl: "http://guest",
          token: "private",
          incarnation: "3",
          cwd: "/repo",
        });
      },
    },
  };
  expect(
    (
      await awaitExecutionBinding(new NoSimulationTask("lease-loss", false), deps, orb.id, {
        signal: new AbortController().signal,
      })
    ).isErr(),
  ).toBe(true);
  expect(harness.deps.control.hasExecutionLeases(orb.id)).toBe(false);
});

it("admits only an existing current-epoch actor on an already running archival guest", async () => {
  const harness = makeHarness();
  const orb = makeOrbRow("orb", "project", "archiving", { hostRef: "host", hostIncarnation: 3 });
  harness.store.seedOrb(orb);
  let present = true;
  const deps = {
    ...harness.deps,
    agentPlane: { session: () => ({ workActive: () => true }) } as never,
    hostProvider: {
      ...harness.deps.hostProvider,
      observe: () =>
        okAsync(
          present
            ? {
                orbId: orb.id,
                ref: { provider: "process", resourceId: "host" },
                incarnation: 3,
                specFingerprint: null,
                state: "running" as const,
              }
            : null,
        ),
      executionBinding: () =>
        okAsync({ baseUrl: "http://guest", token: "private", incarnation: "3", cwd: "/repo" }),
    },
  };
  const task = new NoSimulationTask("archive-lease", false);
  const context = { signal: new AbortController().signal };
  expect((await awaitExecutionBinding(task, deps, orb.id, context)).isErr()).toBe(true);
  const allowed = (
    await awaitExecutionBinding(task, deps, orb.id, context, orb.agentAdmissionVersion)
  )._unsafeUnwrap();
  allowed.release();
  present = false;
  expect(
    (await awaitExecutionBinding(task, deps, orb.id, context, orb.agentAdmissionVersion)).isErr(),
  ).toBe(true);
  expect(harness.deps.control.hasExecutionLeases(orb.id)).toBe(false);
  expect(harness.world.hostCount(orb.id)).toBe(0);
});

describe("execution failure latch", () => {
  it.each(["failed", "deleting", "archiving", "archived"] as const)(
    "does not provision or wait for %s",
    async (state) => {
      const harness = makeHarness();
      harness.store.seedOrb(makeOrbRow("orb", "project", state));
      const result = await awaitExecutionBinding(
        new NoSimulationTask("execution-latch", false),
        harness.deps,
        "orb",
        { signal: new AbortController().signal },
      );
      expect(result.isErr()).toBe(true);
      expect(harness.world.hostCount("orb")).toBe(0);
    },
  );
});

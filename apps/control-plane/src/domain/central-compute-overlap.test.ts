import { NoSimulationTask } from "determined";
import { okAsync, ResultAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow } from "../testkit/fixtures.ts";
import type { AgentPlane } from "./agent-ports.ts";
import { reconcileCentralAgent, reconcileOrbOnce } from "./lifecycle.ts";

it("allocates execution while central resource preparation is held", async () => {
  const h = makeHarness();
  const task = new NoSimulationTask("overlap", false);
  const project = makeProjectRow("project");
  const orb = makeOrbRow("orb", project.id, "starting");
  h.store.seedProject(project);
  h.store.seedOrb(orb);
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  let healthCancelled = false;
  let allocated!: () => void;
  const allocatedHost = new Promise<void>((resolve) => {
    allocated = resolve;
  });
  const provision = h.deps.hostProvider.provision.bind(h.deps.hostProvider);
  const plane: AgentPlane = {
    placement: "central",
    health: (_task, _orb, context) => {
      context.signal.addEventListener(
        "abort",
        () => {
          healthCancelled = true;
        },
        { once: true },
      );
      return ResultAsync.fromSafePromise(ready).map(() => ({
        v: 1,
        orbId: orb.id,
        runtimeInstanceId: "agent",
        status: "initializing",
        phase: "loading_session",
      }));
    },
    deliverMessage: () =>
      okAsync({
        v: 1,
        messageId: "unused",
        status: "queued",
        delivery: "turn",
        operationId: "unused",
        duplicate: false,
      }),
    prepareIdleStop: () => okAsync({ v: 1, prepared: true }),
    pullHistory: () =>
      okAsync({
        v: 1,
        orbId: orb.id,
        runtimeInstanceId: "agent",
        session: { id: "session", overflow: {} },
        activity: "idle",
        records: [],
        cursor: null,
        headId: null,
      }),
    suspend: () => okAsync(undefined),
    dispose: () => okAsync(undefined),
    session: () => null,
    close: () => okAsync(undefined),
  };
  vi.spyOn(h.deps.hostProvider, "provision").mockImplementation((...args) => {
    allocated();
    return provision(...args);
  });
  const deps = { ...h.deps, agentPlane: plane };
  const central = reconcileCentralAgent(
    new NoSimulationTask("central overlap", false),
    deps,
    orb.id,
  );
  const result = reconcileOrbOnce(task, deps, orb.id);
  await allocatedHost;
  expect(healthCancelled).toBe(false);
  release();
  await result;
  await central;
});

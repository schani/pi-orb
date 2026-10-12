import type { SimulationTask } from "determined";
import { err, errAsync, okAsync, ResultAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { DurableAgentPlane } from "../adapters/durable/manager.ts";
import type { AgentPersistence } from "../adapters/durable/persistence.ts";
import { makeHarness, seedRunningOrb } from "../testkit/fixtures.ts";
import { runDst, waitUntil } from "../testkit/sim.ts";
import type { AgentPlane } from "./agent-ports.ts";
import { ControlState } from "./control-state.ts";
import type { RuntimeClientError } from "./errors.ts";
import {
  enqueueOrbMessage,
  reconcileCentralAgent,
  reconcileOrbOnce,
  requestOrbStart,
  requestOrbStop,
} from "./lifecycle.ts";
import type { OrbRow } from "./orb.ts";
import type { ControlPlaneDeps } from "./ports.ts";

type Harness = ReturnType<typeof makeHarness>;
const admission = 7;
const requiredResourceMessage = "required repository resource denied: .pi/skills/platform/SKILL.md";
const terminal: RuntimeClientError = {
  type: "runtime_client_error",
  code: "initialization_failed",
  answered: true,
  retryable: false,
  message: "outer transport explanation",
  initializationError: {
    code: "resource_acquisition_failed",
    message: requiredResourceMessage,
    retryable: false,
  },
};
const unavailable: RuntimeClientError = {
  type: "runtime_client_error",
  code: "unreachable",
  answered: false,
  retryable: true,
  message: "central agent unavailable",
};

function seedBoot(task: SimulationTask, h: Harness, state: "creating" | "starting") {
  seedRunningOrb(task, h, "orb");
  const row = h.store.orbSnapshot("orb")!;
  h.store.seedOrb({ ...row, state, agentAdmissionVersion: admission });
  return h.store.orbSnapshot("orb")!;
}

async function claimOriginalInbox(task: SimulationTask, h: Harness) {
  for (const messageId of ["original-a", "original-b"]) {
    expect(
      (
        await h.store.enqueueOrbMessage(task, {
          orbId: "orb",
          messageId,
          content: [{ type: "text", text: messageId }],
          now: task.wallNow(),
          wake: false,
        })
      ).isOk(),
    ).toBe(true);
  }
  const claimed = (
    await h.store.claimNextOrbMessageBatch(task, {
      orbId: "orb",
      now: task.wallNow(),
    })
  )._unsafeUnwrap();
  expect(claimed).toHaveLength(2);
  expect(claimed.every((row) => row.status === "delivering")).toBe(true);
  return h.store.messageSnapshots("orb");
}

function stubPlane(
  executionReady: NonNullable<AgentPlane["executionReady"]>,
  suspensions: number[],
): AgentPlane {
  return {
    placement: "central",
    executionReady,
    health: () =>
      okAsync({
        v: 1 as const,
        orbId: "orb",
        runtimeInstanceId: "central",
        status: "initializing" as const,
        phase: "booting" as const,
      }),
    deliverMessage: () => errAsync(unavailable),
    prepareIdleStop: () => okAsync({ v: 1 as const, prepared: true }),
    pullHistory: () => errAsync(unavailable),
    suspend: (_task, _orbId, _context, through) => {
      suspensions.push(through ?? -1);
      return okAsync(undefined);
    },
    dispose: () => errAsync(unavailable),
    session: () => ({
      runtimeInstanceId: "central",
      workActive: () => true,
      snapshot: () => err({ message: "not projected" }),
      liveView: () => null,
      subscribe: () => () => undefined,
      request: () => errAsync(unavailable),
    }),
    close: () => okAsync(undefined),
  };
}

function expectSafeFailure(h: Harness, before: OrbRow) {
  expect(h.store.orbSnapshot("orb")).toMatchObject({
    state: "failed",
    stateVersion: before.stateVersion + 1,
    lastError: `runtime_failed: resource_acquisition_failed: ${requiredResourceMessage}`,
    checkoutCommit: before.checkoutCommit,
    lastReadyAt: before.lastReadyAt,
    hostRef: before.hostRef,
    hostIncarnation: before.hostIncarnation,
    runtimeTokenHash: null,
    hostDiscardThroughIncarnation: before.hostIncarnation,
    hostDiscardReason: "failed",
    hostDiscardEvidence: expect.any(String),
    hostDiscardRequestedAt: expect.any(Number),
    agentAdmissionVersion: admission,
    stopReason: before.stopReason,
  });
}

describe("central execution resource readiness", () => {
  const cases: readonly { name: string; error: RuntimeClientError; fails: boolean }[] = [
    { name: "proven terminal resource failure", error: terminal, fails: true },
    {
      name: "retryable typed initialization failure",
      error: {
        ...terminal,
        retryable: true,
        initializationError: { ...terminal.initializationError!, retryable: true },
      },
      fails: false,
    },
    {
      name: "unanswered typed terminal failure",
      error: { ...terminal, answered: false },
      fails: false,
    },
    {
      name: "generic nonretryable failure",
      error: {
        type: "runtime_client_error",
        code: "invalid_response",
        answered: true,
        retryable: false,
        message: "resource response unavailable",
      },
      fails: false,
    },
    {
      name: "initialization failure without typed detail",
      error: {
        type: "runtime_client_error",
        code: "initialization_failed",
        answered: true,
        retryable: false,
        message: "unproven initialization failure",
      },
      fails: false,
    },
  ];

  for (const state of ["creating", "starting"] as const) {
    for (const scenario of cases) {
      it(`${state}: ${scenario.name} across control-state and plane reload`, async () => {
        await runDst(
          {
            name: `central-resource-boundary-${state}-${scenario.name}`,
            iterations: 10,
            lateTimerProbability: 0,
          },
          async (sim) => {
            const h = makeHarness();
            const suspensions: number[] = [];
            let calls = 0;
            const createPlane = () =>
              stubPlane(() => {
                calls++;
                return errAsync(scenario.error);
              }, suspensions);
            let deps: ControlPlaneDeps = { ...h.deps, agentPlane: createPlane() };
            const result = await sim.runTasks([
              {
                name: "driver",
                f: async (task) => {
                  seedBoot(task, h, state);
                  const inbox = await claimOriginalInbox(task, h);
                  const before = h.store.orbSnapshot("orb")!;
                  let conversationClosed = 0;
                  let executionClosed = 0;
                  deps.control.registerBrowserConnection(
                    "orb",
                    "conversation",
                    () => conversationClosed++,
                  );
                  deps.control.registerBrowserConnection(
                    "orb",
                    "execution",
                    () => executionClosed++,
                    "execution",
                  );
                  const outcome = await reconcileOrbOnce(task, deps, "orb");
                  expect(calls).toBe(1);
                  expect(outcome).toEqual(
                    scenario.fails
                      ? { type: "transitioned", toState: "failed" }
                      : { type: "waiting", reason: "readiness" },
                  );
                  if (scenario.fails) {
                    expectSafeFailure(h, before);
                    expect(executionClosed).toBe(1);
                    expect(deps.control.hasAgentWork("orb")).toBe(true);
                  } else {
                    expect(h.store.orbSnapshot("orb")).toEqual(before);
                    expect(deps.control.getBootProbe("orb")?.lastError).toBe(
                      scenario.error.message,
                    );
                    expect(executionClosed).toBe(0);
                  }
                  expect(conversationClosed).toBe(0);
                  expect(suspensions).toEqual([]);
                  expect(h.store.messageSnapshots("orb")).toEqual(inbox);
                  await deps.agentPlane!.close();
                  deps = { ...deps, control: new ControlState(), agentPlane: createPlane() };
                  const reloaded = await reconcileOrbOnce(task, deps, "orb");
                  if (scenario.fails) {
                    // The durable discard intent wins after process-local readiness state is lost.
                    expect(h.store.orbSnapshot("orb")).toMatchObject({
                      state: "failed",
                      agentAdmissionVersion: admission,
                      lastError: `runtime_failed: resource_acquisition_failed: ${requiredResourceMessage}`,
                    });
                    expect(calls).toBe(1);
                  } else {
                    expect(reloaded).toEqual({ type: "waiting", reason: "readiness" });
                    expect(h.store.orbSnapshot("orb")).toEqual(before);
                    expect(calls).toBe(2);
                  }
                  expect(suspensions).toEqual([]);
                  expect(h.store.messageSnapshots("orb")).toEqual(inbox);
                },
              },
            ]);
            expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
          },
        );
      });
    }

    for (const reload of [false, true]) {
      it(`${state}: real prepare failure reaches executionReady and safe failure (reload=${reload})`, async () => {
        await runDst(
          {
            name: `central-resource-real-prepare-${state}-${reload}`,
            iterations: 10,
            lateTimerProbability: 0,
          },
          async (sim) => {
            const h = makeHarness();
            let preparations = 0;
            let storageOpens = 0;
            let contextOpens = 0;
            const persistence: AgentPersistence = {
              open: () => {
                storageOpens++;
                return errAsync(unavailable);
              },
              snapshot: () => errAsync(unavailable),
              dispose: () => okAsync(undefined),
              close: () => okAsync(undefined),
            };
            const createPlane = () =>
              DurableAgentPlane.create({
                persistence,
                prepare: (_task, orb) => {
                  preparations++;
                  h.store.seedResourceFailure(orb.id, orb.agentAdmissionVersion);
                  return errAsync(terminal);
                },
                openContext: () => {
                  contextOpens++;
                  return errAsync(unavailable);
                },
              }).map((plane) => {
                const executionReady = plane.executionReady.bind(plane);
                // Bridge determined's signal to the native adapter boundary.
                plane.executionReady = (task, orb, context) => {
                  const abort = new AbortController();
                  const forwardAbort = () => abort.abort(context.signal.reason);
                  if (context.signal.aborted) forwardAbort();
                  else context.signal.addEventListener("abort", forwardAbort, { once: true });
                  const cleanup = () => context.signal.removeEventListener("abort", forwardAbort);
                  return executionReady(task, orb, { signal: abort.signal })
                    .map((value) => {
                      cleanup();
                      return value;
                    })
                    .mapErr((error) => {
                      cleanup();
                      return error;
                    });
                };
                return plane;
              });
            const result = await sim.runTasks([
              {
                name: "driver",
                f: async (task) => {
                  const before = seedBoot(task, h, state);
                  const inbox = await claimOriginalInbox(task, h);
                  let plane = (await createPlane())._unsafeUnwrap();
                  let deps: ControlPlaneDeps = { ...h.deps, agentPlane: plane };
                  try {
                    const readiness = await plane.executionReady(task, before, {
                      signal: new AbortController().signal,
                    });
                    // This must retain prepare's typed error, not health's generic unavailable error.
                    expect(readiness._unsafeUnwrapErr()).toEqual({
                      ...terminal,
                      message: terminal.initializationError!.message,
                    });
                    expect(preparations).toBe(1);
                    expect(storageOpens).toBe(0);
                    expect(contextOpens).toBe(0);
                    if (reload) {
                      await plane.close();
                      plane = (await createPlane())._unsafeUnwrap();
                      deps = { ...deps, control: new ControlState(), agentPlane: plane };
                    }
                    expect(await reconcileOrbOnce(task, deps, "orb")).toEqual({
                      type: "transitioned",
                      toState: "failed",
                    });
                    expectSafeFailure(h, before);
                    expect(preparations).toBe(2);
                    expect(storageOpens).toBe(0);
                    expect(contextOpens).toBe(0);
                    expect(h.store.messageSnapshots("orb")).toEqual(inbox);
                    await plane.close();
                    plane = (await createPlane())._unsafeUnwrap();
                    deps = { ...deps, control: new ControlState(), agentPlane: plane };
                    await reconcileOrbOnce(task, deps, "orb");
                    expect(h.store.orbSnapshot("orb")).toMatchObject({
                      state: "failed",
                      agentAdmissionVersion: admission,
                    });
                    expect(preparations).toBe(2);
                    expect(storageOpens).toBe(0);
                    expect(contextOpens).toBe(0);
                    expect(h.store.messageSnapshots("orb")).toEqual(inbox);
                  } finally {
                    await plane.close();
                  }
                },
              },
            ]);
            expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
          },
        );
      });
    }
  }

  for (const trigger of ["start", "input"] as const) {
    for (const snapshot of [false, true]) {
      it(`failed readiness: ${trigger} renews current resource failure once (snapshot=${snapshot})`, async () => {
        await runDst(
          {
            name: `central-resource-readiness-retry-${trigger}-${snapshot}`,
            iterations: 10,
            lateTimerProbability: 0,
          },
          async (sim) => {
            const h = makeHarness();
            const suspensions: number[] = [];
            const deps: ControlPlaneDeps = {
              ...h.deps,
              agentPlane: stubPlane(() => errAsync(terminal), suspensions),
            };
            const result = await sim.runTasks([
              {
                name: "driver",
                f: async (task) => {
                  const before = seedBoot(task, h, "starting");
                  const inbox = await claimOriginalInbox(task, h);
                  h.store.seedResourceFailure("orb", admission);
                  if (snapshot) h.store.seedResourceSnapshot("orb");
                  expect(await reconcileOrbOnce(task, deps, "orb")).toEqual({
                    type: "transitioned",
                    toState: "failed",
                  });
                  expectSafeFailure(h, before);
                  if (trigger === "start") {
                    expect((await requestOrbStart(task, deps, "orb")).isOk()).toBe(true);
                  } else {
                    expect(
                      (
                        await enqueueOrbMessage(task, deps, {
                          orbId: "orb",
                          messageId: "fresh-input",
                          content: [{ type: "text", text: "retry resources" }],
                        })
                      ).isOk(),
                    ).toBe(true);
                    // Admission enqueues; central reconciliation owns the wake CAS.
                    expect(h.store.orbSnapshot("orb")?.state).toBe("failed");
                    await reconcileCentralAgent(task, deps, "orb");
                  }
                  const expected = admission + (snapshot ? 0 : 1);
                  expect(h.store.orbSnapshot("orb")).toMatchObject({
                    state: "starting",
                    agentAdmissionVersion: expected,
                    lastError: null,
                  });
                  for (let pass = 0; pass < 3; pass++) {
                    expect((await requestOrbStart(task, deps, "orb")).isOk()).toBe(true);
                    await reconcileCentralAgent(task, deps, "orb");
                    expect(h.store.orbSnapshot("orb")?.agentAdmissionVersion).toBe(expected);
                  }
                  expect(suspensions).toEqual([]);
                  expect(h.store.messageSnapshots("orb").slice(0, 2)).toEqual(inbox);
                },
              },
            ]);
            expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
          },
        );
      });
    }
  }

  for (const state of ["creating", "starting"] as const) {
    it(`${state}: late typed terminal readiness cannot overwrite completed Stop`, async () => {
      await runDst(
        {
          name: `central-resource-readiness-stop-cas-${state}`,
          iterations: 20,
          lateTimerProbability: 0,
        },
        async (sim) => {
          const h = makeHarness();
          const suspensions: number[] = [];
          let blocked = false;
          let stopped = false;
          let stopRow: OrbRow | undefined;
          const deps: ControlPlaneDeps = {
            ...h.deps,
            agentPlane: stubPlane(
              (task) =>
                new ResultAsync(
                  (async () => {
                    blocked = true;
                    await task.checkpoint("central-resource-readiness.terminal-result-blocked");
                    await waitUntil(
                      task,
                      "Stop completed before terminal readiness",
                      () => stopped,
                      {
                        intervalMs: 1,
                      },
                    );
                    await task.checkpoint("central-resource-readiness.release-terminal-result");
                    return err(terminal);
                  })(),
                ),
              suspensions,
            ),
          };
          const result = await sim.runTasks([
            {
              name: "readiness",
              f: async (task) => {
                const before = seedBoot(task, h, state);
                h.store.seedOrb({ ...before, lastError: "prior boot evidence" });
                expect(await reconcileOrbOnce(task, deps, "orb")).toEqual({ type: "conflict" });
                expect(stopRow).toBeDefined();
                expect(h.store.orbSnapshot("orb")).toEqual(stopRow);
                expect(h.store.orbSnapshot("orb")).toMatchObject({
                  state: "stopped",
                  stateVersion: 2,
                  stopReason: "manual",
                  agentAdmissionVersion: admission + 1,
                  hostDiscardThroughIncarnation: null,
                  hostDiscardReason: null,
                  hostDiscardError: null,
                  hostDiscardEvidence: null,
                  hostDiscardRequestedAt: null,
                  lastError: "stop retained evidence",
                });
                expect(suspensions).toEqual([admission + 1]);
              },
            },
            {
              name: "stop",
              f: async (task) => {
                await waitUntil(task, "terminal readiness blocked", () => blocked, {
                  intervalMs: 1,
                });
                expect((await requestOrbStop(task, deps, "orb")).isOk()).toBe(true);
                const stoppingRow = h.store.orbSnapshot("orb")!;
                expect(stoppingRow.state).toBe("stopping");
                expect(stoppingRow.stateVersion).toBe(1);
                // Complete Stop with newer evidence before releasing the stale readiness result.
                stopRow = (
                  await h.store.casTransition(task, {
                    orbId: "orb",
                    expectedStateVersion: stoppingRow.stateVersion,
                    toState: "stopped",
                    now: task.wallNow(),
                    lastError: "stop retained evidence",
                  })
                )._unsafeUnwrap();
                expect(stopRow.state).toBe("stopped");
                expect(stopRow.stateVersion).toBe(stoppingRow.stateVersion + 1);
                await task.checkpoint("central-resource-readiness.stop-command-completed");
                stopped = true;
              },
            },
          ]);
          expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        },
      );
    });
  }
});

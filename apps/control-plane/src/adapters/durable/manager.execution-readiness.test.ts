import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { RuntimeHealth } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { errAsync, okAsync, type Result, ResultAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeClientError } from "../../domain/errors.ts";
import { resourceError } from "../../domain/resources.ts";
import { makeOrbRow } from "../../testkit/fixtures.ts";
import { runDst } from "../../testkit/sim.ts";
import type { DurableAgentOptions } from "./agent.ts";
import { DurableAgentPlane, type DurableAgentPlaneOptions, durableError } from "./manager.ts";
import { MemoryAgentPersistence } from "./memory-persistence.testkit.ts";

const orb = makeOrbRow("orb", "project", "starting");
const context = () => ({ signal: new AbortController().signal });
const task = () => new NoSimulationTask("execution-readiness", false);
const resourcePath = ".pi/skills/platform/SKILL.md";
const longPath = `.pi/resources/${"segment/".repeat(220)}snapshot.json`;
const safeMessage = `Required resource snapshot unavailable: ${resourcePath} (${longPath})`.slice(
  0,
  1536,
);

function resourceFailure(code: "storage" | "fetch" | "invalid"): RuntimeClientError {
  // Fixed first-party paths, not repository contents or third-party error text.
  const failure = resourceError(
    code,
    `Required resource snapshot unavailable: ${resourcePath}\u0000\n\u007f\u0085\u202e\u2066 (${longPath})`,
  );
  return {
    type: "runtime_client_error",
    code: "initialization_failed",
    answered: true,
    message: failure.message,
    retryable: failure.code === "storage",
    initializationError: {
      code: "resource_acquisition_failed",
      message: failure.message,
      retryable: failure.code === "storage",
    },
  };
}

async function createPlane(
  prepare: DurableAgentPlaneOptions["prepare"],
  hydrateExecution: DurableAgentOptions["hydrateExecution"] = () => okAsync(undefined),
) {
  const persistence = new MemoryAgentPersistence();
  const open = vi.spyOn(persistence, "open");
  const openContext = vi.fn(() =>
    okAsync({
      models: createModels(),
      registry: createRegistry(),
      env: new NodeExecutionEnv({ cwd: "/tmp" }),
      checkoutCommit: "commit",
      instructions: "instruction",
      hydrateExecution,
    }),
  );
  const plane = (
    await DurableAgentPlane.create({
      persistence,
      ...(prepare !== undefined ? { prepare } : {}),
      openContext,
    })
  )._unsafeUnwrap();
  return { plane, open, openContext };
}

function assertResourceFailure(
  failure: RuntimeClientError,
  health: Result<RuntimeHealth, RuntimeClientError>,
  readiness: Result<void, RuntimeClientError>,
) {
  expect(failure.message).toBe(safeMessage);
  expect(failure.message).toHaveLength(1536);
  expect(failure.message).toContain(resourcePath);
  expect(failure.initializationError).toEqual({
    code: "resource_acquisition_failed",
    message: safeMessage,
    retryable: failure.retryable,
  });
  expect(health._unsafeUnwrap()).toEqual({
    v: 1,
    orbId: orb.id,
    runtimeInstanceId: `agent:${orb.id}`,
    status: "failed",
    error: failure.initializationError,
  });
  const failedHealth = health._unsafeUnwrap();
  if (failedHealth.status === "failed")
    expect(failedHealth.error).toBe(failure.initializationError);
  expect(readiness.isErr()).toBe(true);
  const error = readiness._unsafeUnwrapErr();
  expect(error).toEqual({
    type: "runtime_client_error",
    code: "initialization_failed",
    answered: true,
    message: safeMessage,
    retryable: failure.retryable,
    initializationError: failure.initializationError,
  });
  expect(error.initializationError).toBe(failure.initializationError);
}

describe("durable execution readiness", () => {
  it.each(["storage", "fetch", "invalid"] as const)(
    "retains the sanitized prepare failure for %s through health and executionReady",
    async (code) => {
      const failure = resourceFailure(code);
      const prepare = vi.fn(() => errAsync(failure));
      const fixture = await createPlane(prepare);
      try {
        const health = await fixture.plane.health(task(), orb, context());
        // Check health before executionReady, which performs another real prepare attempt.
        expect(health._unsafeUnwrap()).toEqual({
          v: 1,
          orbId: orb.id,
          runtimeInstanceId: `agent:${orb.id}`,
          status: "failed",
          error: failure.initializationError,
        });
        const failedHealth = health._unsafeUnwrap();
        if (failedHealth.status === "failed")
          expect(failedHealth.error).toBe(failure.initializationError);
        expect(fixture.open).not.toHaveBeenCalled();
        expect(fixture.openContext).not.toHaveBeenCalled();

        const readiness = await fixture.plane.executionReady(task(), orb, context());
        expect(prepare).toHaveBeenCalledTimes(2);
        expect(fixture.open).not.toHaveBeenCalled();
        expect(fixture.openContext).not.toHaveBeenCalled();
        assertResourceFailure(failure, health, readiness);
      } finally {
        await fixture.plane.close();
      }
    },
  );

  it("preserves initializing health from a real prepare failure as a retryable error", async () => {
    const initializationHealth = {
      v: 1 as const,
      orbId: orb.id,
      runtimeInstanceId: "execution",
      status: "initializing" as const,
      phase: "setup_running" as const,
      hooks: {},
    };
    const failure: RuntimeClientError = {
      type: "runtime_client_error",
      code: "http_error",
      answered: true,
      message: "execution initializing",
      retryable: true,
      initializationHealth,
    };
    const fixture = await createPlane(() => errAsync(failure));
    try {
      expect((await fixture.plane.health(task(), orb, context()))._unsafeUnwrap()).toBe(
        initializationHealth,
      );
      const result = await fixture.plane.executionReady(task(), orb, context());
      expect(fixture.open).not.toHaveBeenCalled();
      expect(fixture.openContext).not.toHaveBeenCalled();
      expect(result._unsafeUnwrapErr()).toMatchObject({
        type: "runtime_client_error",
        answered: true,
        retryable: true,
        initializationHealth,
      });
      expect(result._unsafeUnwrapErr().initializationHealth).toBe(initializationHealth);
    } finally {
      await fixture.plane.close();
    }
  });

  it("makes an absent central agent retryable when health reports ready", async () => {
    const fixture = await createPlane(undefined);
    // Real ready health always installs an agent; this isolates the defensive fallback.
    vi.spyOn(fixture.plane, "health").mockReturnValue(
      okAsync({
        v: 1,
        orbId: orb.id,
        runtimeInstanceId: "ready-without-agent",
        status: "ready",
        sessionId: "session",
        checkoutCommit: "commit",
        activity: "idle",
        hooks: {},
      }),
    );
    try {
      const result = await fixture.plane.executionReady(task(), orb, context());
      expect(result._unsafeUnwrapErr()).toEqual(durableError("central agent unavailable", true));
      expect(fixture.open).not.toHaveBeenCalled();
      expect(fixture.openContext).not.toHaveBeenCalled();
    } finally {
      await fixture.plane.close();
    }
  });

  it.each([true, false])(
    "passes transport unavailability through with retryable=%s",
    async (retryable) => {
      const failure: RuntimeClientError = {
        type: "runtime_client_error",
        code: "unreachable",
        answered: false,
        message: "execution transport unavailable",
        retryable,
      };
      const fixture = await createPlane(() => errAsync(failure));
      try {
        const result = await fixture.plane.executionReady(task(), orb, context());
        expect(result._unsafeUnwrapErr()).toBe(failure);
        expect(fixture.open).not.toHaveBeenCalled();
        expect(fixture.openContext).not.toHaveBeenCalled();
      } finally {
        await fixture.plane.close();
      }
    },
  );

  it("hydrates a real ready agent successfully", async () => {
    const hydrate = vi.fn(() => okAsync(undefined));
    const fixture = await createPlane(() => okAsync(undefined), hydrate);
    try {
      expect((await fixture.plane.health(task(), orb, context()))._unsafeUnwrap().status).toBe(
        "ready",
      );
      expect(hydrate).not.toHaveBeenCalled();
      expect((await fixture.plane.executionReady(task(), orb, context()))._unsafeUnwrap()).toBe(
        undefined,
      );
      expect(hydrate).toHaveBeenCalledTimes(1);
      expect(fixture.open).toHaveBeenCalledTimes(1);
      expect(fixture.openContext).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.plane.close();
    }
  });

  it.each([true, false])(
    "passes real agent hydration failure through with retryable=%s",
    async (retryable) => {
      const failure: RuntimeClientError = {
        type: "runtime_client_error",
        code: "unreachable",
        answered: false,
        message: "compute unavailable",
        retryable,
      };
      const hydrate = vi.fn(() => errAsync(failure));
      const fixture = await createPlane(() => okAsync(undefined), hydrate);
      try {
        expect((await fixture.plane.health(task(), orb, context()))._unsafeUnwrap().status).toBe(
          "ready",
        );
        const result = await fixture.plane.executionReady(task(), orb, context());
        expect(result._unsafeUnwrapErr()).toBe(failure);
        expect(hydrate).toHaveBeenCalledTimes(1);
        expect(fixture.open).toHaveBeenCalledTimes(1);
        expect(fixture.openContext).toHaveBeenCalledTimes(1);
      } finally {
        await fixture.plane.close();
      }
    },
  );

  it("does not prepare or acquire ownership for a pre-aborted executionReady", async () => {
    const prepare = vi.fn(() => okAsync(undefined));
    const hydrate = vi.fn(() => okAsync(undefined));
    const fixture = await createPlane(prepare, hydrate);
    const abort = new AbortController();
    abort.abort();
    try {
      const result = await fixture.plane.executionReady(task(), orb, { signal: abort.signal });
      expect(result._unsafeUnwrapErr()).toEqual({
        ...durableError("agent open cancelled"),
        code: "cancelled",
      });
      expect(prepare).not.toHaveBeenCalled();
      expect(fixture.open).not.toHaveBeenCalled();
      expect(fixture.openContext).not.toHaveBeenCalled();
      expect(hydrate).not.toHaveBeenCalled();
    } finally {
      await fixture.plane.close();
    }
  });

  it("cancels in-flight preparation on Stop and rejects the stale admission without hydration", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const cancelled: RuntimeClientError = {
      ...durableError("resource preparation cancelled", true),
      code: "cancelled",
    };
    const prepare = vi.fn<NonNullable<DurableAgentPlaneOptions["prepare"]>>(
      (_task, _orb, operationContext) =>
        ResultAsync.fromSafePromise(
          new Promise<void>((resolve) => {
            operationContext.signal.addEventListener("abort", () => resolve(), { once: true });
            entered();
          }),
        ).andThen(() => errAsync(cancelled)),
    );
    const hydrate = vi.fn(() => okAsync(undefined));
    const fixture = await createPlane(prepare, hydrate);
    const currentTask = task();
    const operationContext = context();
    try {
      const pending = fixture.plane.executionReady(currentTask, orb, operationContext);
      await started;
      const stopped = {
        ...orb,
        state: "stopped" as const,
        stopReason: "manual" as const,
        agentAdmissionVersion: orb.agentAdmissionVersion + 1,
      };
      const stopping = fixture.plane.suspend(
        currentTask,
        stopped.id,
        operationContext,
        stopped.agentAdmissionVersion,
      );
      expect((await pending)._unsafeUnwrapErr()).toBe(cancelled);
      expect((await stopping).isOk()).toBe(true);
      const stale = await fixture.plane.executionReady(currentTask, orb, operationContext);
      expect(stale._unsafeUnwrapErr()).toEqual(durableError("stale agent admission authority"));
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(fixture.open).not.toHaveBeenCalled();
      expect(fixture.openContext).not.toHaveBeenCalled();
      expect(hydrate).not.toHaveBeenCalled();
    } finally {
      await fixture.plane.close();
    }
  });

  it("replays checkpointed resource failures with both retryabilities", async () => {
    await runDst(
      { name: "durable-execution-readiness-resource-failure", iterations: 5 },
      async (sim) => {
        const observations: {
          failure: RuntimeClientError;
          health: Result<RuntimeHealth, RuntimeClientError>;
          readiness: Result<void, RuntimeClientError>;
          fixture: Awaited<ReturnType<typeof createPlane>>;
        }[] = [];
        const result = await sim.runTasks([
          {
            name: "resource-failure",
            f: async (simulationTask) => {
              for (const code of ["storage", "fetch"] as const) {
                const failure = resourceFailure(code);
                const fixture = await createPlane((prepareTask) =>
                  ResultAsync.fromSafePromise(prepareTask.checkpoint(`prepare-${code}`)).andThen(
                    () => errAsync(failure),
                  ),
                );
                try {
                  const health = await fixture.plane.health(simulationTask, orb, context());
                  const readiness = await fixture.plane.executionReady(
                    simulationTask,
                    orb,
                    context(),
                  );
                  observations.push({ failure, health, readiness, fixture });
                } finally {
                  await fixture.plane.close();
                }
              }
            },
          },
        ]);
        // Assertions stay outside runTasks so runDst records and replays their failures.
        expect(result.isOk()).toBe(true);
        expect(observations).toHaveLength(2);
        expect(observations.map(({ failure }) => failure.retryable)).toEqual([true, false]);
        for (const { failure, health, readiness, fixture } of observations) {
          expect(fixture.open).not.toHaveBeenCalled();
          expect(fixture.openContext).not.toHaveBeenCalled();
          assertResourceFailure(failure, health, readiness);
        }
      },
    );
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { RuntimeHealthSchema } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { Check } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeClientError } from "../../domain/errors.ts";
import { makeOrbRow } from "../../testkit/fixtures.ts";
import { runDst } from "../../testkit/sim.ts";
import { DurableAgentPlane, OrbAgentManager } from "./manager.ts";
import { MemoryAgentPersistence } from "./memory-persistence.testkit.ts";

function barrier<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("execution initialization health", () => {
  it("reports answered initializing health without opening an agent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "durable-initializing-health-"));
    const initializationHealth = {
      v: 1 as const,
      orbId: "orb",
      runtimeInstanceId: "execution",
      status: "initializing" as const,
      phase: "setup_running" as const,
      hooks: {},
    };
    const plane = (
      await DurableAgentPlane.create({
        persistence: new MemoryAgentPersistence(),
        openContext: () =>
          errAsync({
            type: "runtime_client_error",
            code: "http_error",
            answered: true,
            message: "execution initializing",
            retryable: true,
            initializationHealth,
          }),
      })
    )._unsafeUnwrap();
    try {
      const task = new NoSimulationTask("initializing-health", false);
      const orb = makeOrbRow("orb", "project", "starting", { hostIncarnation: 1 });
      const context = { signal: new AbortController().signal };
      const result = await plane.health(task, orb, context);
      expect(result._unsafeUnwrap()).toBe(initializationHealth);
      const readiness = (await plane.executionReady(task, orb, context))._unsafeUnwrapErr();
      expect(readiness).toMatchObject({
        type: "runtime_client_error",
        answered: true,
        retryable: true,
        initializationHealth,
      });
      expect(readiness.initializationHealth).toBe(initializationHealth);
      expect(plane.session("orb")).toBeNull();
    } finally {
      await plane.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { code: "clone_failed", retryable: true },
    { code: "clone_failed", retryable: false },
    { code: "e2e_launch_failure", retryable: true },
    { code: "e2e_launch_failure", retryable: false },
  ])(
    "reports proven $code retryable=$retryable and permits a fresh explicit start",
    async ({ code, retryable }) => {
      const directory = await mkdtemp(join(tmpdir(), "durable-init-health-"));
      const initializationError = {
        code,
        message: "repository unavailable",
        retryable,
      };
      let attempts = 0;
      const plane = (
        await DurableAgentPlane.create({
          persistence: new MemoryAgentPersistence(),
          openContext: () => {
            attempts++;
            return attempts <= 2
              ? errAsync({
                  type: "runtime_client_error",
                  code: "initialization_failed",
                  answered: true,
                  message: initializationError.message,
                  retryable,
                  initializationError,
                })
              : okAsync({
                  models: createModels(),
                  registry: createRegistry(),
                  env: new NodeExecutionEnv({ cwd: directory }),
                  checkoutCommit: "commit",
                  instructions: "instruction",
                });
          },
        })
      )._unsafeUnwrap();
      const task = new NoSimulationTask("initialization-health", false);
      const context = { signal: new AbortController().signal };
      const orb = makeOrbRow("orb", "project", "starting", { hostIncarnation: 1 });
      try {
        const failed = (await plane.health(task, orb, context))._unsafeUnwrap();
        expect(failed).toEqual({
          v: 1,
          orbId: "orb",
          runtimeInstanceId: "agent:orb",
          status: "failed",
          error: initializationError,
        });
        expect(Check(RuntimeHealthSchema, failed)).toBe(true);
        if (failed.status === "failed") expect(failed.error).toBe(initializationError);
        const readiness = (await plane.executionReady(task, orb, context))._unsafeUnwrapErr();
        expect(readiness).toEqual({
          type: "runtime_client_error",
          code: "initialization_failed",
          answered: true,
          message: initializationError.message,
          retryable,
          initializationError,
        });
        expect(readiness.initializationError).toBe(initializationError);
        expect(attempts).toBe(2);
        expect(plane.session("orb")).toBeNull();
        await plane.suspend(task, "orb", context);
        const ready = (
          await plane.health(task, { ...orb, hostIncarnation: 2 }, context)
        )._unsafeUnwrap();
        expect(ready.status).toBe("ready");
        expect(attempts).toBe(3);
      } finally {
        await plane.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([
    { code: "unreachable", answered: false, retryable: true },
    { code: "http_error", answered: true, retryable: true },
    { code: "invalid_response", answered: true, retryable: false },
    { code: "initialization_failed", answered: true, retryable: false },
    { code: "initialization_failed", answered: true, retryable: true },
  ] as const)(
    "keeps unproven/transient error $code retryable=$retryable as Err",
    async (detail) => {
      const directory = await mkdtemp(join(tmpdir(), "durable-transient-health-"));
      const failure: RuntimeClientError = {
        type: "runtime_client_error",
        message: "not ready",
        ...detail,
      };
      const plane = (
        await DurableAgentPlane.create({
          persistence: new MemoryAgentPersistence(),
          openContext: () => errAsync(failure),
        })
      )._unsafeUnwrap();
      try {
        const task = new NoSimulationTask("transient-health", false);
        const orb = makeOrbRow("orb", "project", "starting", { hostIncarnation: 1 });
        const context = { signal: new AbortController().signal };
        expect((await plane.health(task, orb, context))._unsafeUnwrapErr()).toBe(failure);
        expect((await plane.executionReady(task, orb, context))._unsafeUnwrapErr()).toBe(failure);
      } finally {
        await plane.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

it("replays checkpointed resource failures with both retryabilities", async () => {
  const options = { name: "durable-execution-readiness-resource-failure", iterations: 5 };
  await runDst(options, async (sim) => {
    const result = await sim.runTasks(
      [true, false].map((retryable) => ({
        name: `resource-failure-${retryable}`,
        f: async (task) => {
          const failure: RuntimeClientError = {
            type: "runtime_client_error",
            code: "initialization_failed",
            answered: true,
            message: "Required resource snapshot unavailable: .pi/skills/platform/SKILL.md",
            retryable,
            initializationError: {
              code: "resource_acquisition_failed",
              message: "Required resource snapshot unavailable: .pi/skills/platform/SKILL.md",
              retryable,
            },
          };
          const persistence = new MemoryAgentPersistence();
          const open = vi.spyOn(persistence, "open");
          const openContext = vi.fn(() => errAsync(failure));
          const plane = (
            await DurableAgentPlane.create({
              persistence,
              openContext,
              prepare: (task) =>
                ResultAsync.fromSafePromise(task.checkpoint(`prepare-${retryable}`)).andThen(() =>
                  errAsync(failure),
                ),
            })
          )._unsafeUnwrap();
          const orb = makeOrbRow("orb", "project", "starting");
          const context = { signal: new AbortController().signal };
          try {
            const failed = (await plane.health(task, orb, context))._unsafeUnwrap();
            expect(failed.status).toBe("failed");
            if (failed.status === "failed") expect(failed.error).toBe(failure.initializationError);
            const error = (await plane.executionReady(task, orb, context))._unsafeUnwrapErr();
            expect(error).toEqual(failure);
            expect(error.initializationError).toBe(failure.initializationError);
            expect(error.retryable).toBe(failure.retryable);
            expect(open).not.toHaveBeenCalled();
            expect(openContext).not.toHaveBeenCalled();
          } finally {
            await plane.close();
          }
        },
      })),
    );
    expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
  });
});
describe("orb Harness ownership", () => {
  it("advances the revocation floor even before an old owner was observed", async () => {
    const manager = new OrbAgentManager<number>({
      open: (_id, version) => okAsync(version),
      close: () => okAsync(undefined),
    });
    await manager.suspend("orb", 2);
    expect((await manager.ensure("orb", 0, undefined, true)).isErr()).toBe(true);
    expect((await manager.ensure("orb", 3, undefined, true))._unsafeUnwrap()).toBe(3);
    await manager.close();
  });

  it("ignores a delayed Stop after a newer authority was admitted", async () => {
    const opening = barrier<void>();
    const release = barrier<void>();
    const closed: number[] = [];
    const manager = new OrbAgentManager<{ version: number }>({
      open: (_id, version) => {
        opening.resolve();
        return ResultAsync.fromSafePromise(release.promise).map(() => ({ version }));
      },
      close: (agent) => {
        closed.push(agent.version);
        return okAsync(undefined);
      },
    });
    const pending = manager.ensure("orb", 3, undefined, true);
    await opening.promise;
    expect((await manager.suspend("orb", 2)).isOk()).toBe(true);
    release.resolve();
    expect((await pending).isOk()).toBe(true);
    expect(closed).toEqual([]);
    await manager.close();
    expect(closed).toEqual([3]);
  });

  it("keeps central ownership when compute changes or fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "durable-independent-health-"));
    let opens = 0;
    const plane = (
      await DurableAgentPlane.create({
        persistence: new MemoryAgentPersistence(),
        openContext: () => {
          opens++;
          return okAsync({
            models: createModels(),
            registry: createRegistry(),
            env: new NodeExecutionEnv({ cwd: directory }),
            checkoutCommit: null,
            instructions: "Pinned instructions",
          });
        },
      })
    )._unsafeUnwrap();
    const task = new NoSimulationTask("independent-health", false);
    const context = { signal: new AbortController().signal };
    const orb = makeOrbRow("orb", "project", "starting", { hostIncarnation: 1 });
    try {
      const first = (await plane.health(task, orb, context))._unsafeUnwrap();
      const second = (
        await plane.health(task, { ...orb, hostIncarnation: 2, state: "failed" }, context)
      )._unsafeUnwrap();
      expect(second.runtimeInstanceId).toBe(first.runtimeInstanceId);
      expect(second.status).toBe("ready");
      expect(opens).toBe(1);
    } finally {
      await plane.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("shares concurrent opening and closes only after an admitted open", async () => {
    const admitted = barrier<void>();
    const release = barrier<void>();
    let opens = 0;
    let closes = 0;
    const manager = new OrbAgentManager<{ incarnation: number }>({
      open: () => {
        opens++;
        admitted.resolve();
        return ResultAsync.fromPromise(
          release.promise.then(() => ({ incarnation: 1 })),
          () => ({
            type: "runtime_client_error" as const,
            code: "history_unavailable" as const,
            answered: true,
            retryable: false,
            message: "fixture failed",
          }),
        );
      },
      close: () => {
        closes++;
        return okAsync(undefined);
      },
    });
    const a = manager.ensure("orb", 1);
    await admitted.promise;
    const b = manager.ensure("orb", 1);
    const closing = manager.suspend("orb");
    release.resolve();
    expect((await a).isErr()).toBe(true);
    expect((await b).isErr()).toBe(true);
    expect((await closing).isOk()).toBe(true);
    expect(opens).toBe(1);
    expect(closes).toBe(1);
    expect(manager.get("orb")).toBeNull();
    expect((await manager.ensure("orb", 1)).isErr()).toBe(true);
  });
  it("shares an authority version and refuses stale admissions after revocation", async () => {
    const closed: number[] = [];
    const manager = new OrbAgentManager<{ incarnation: number }>({
      open: (_id, incarnation) => okAsync({ incarnation }),
      close: (agent) => {
        closed.push(agent.incarnation);
        return okAsync(undefined);
      },
    });
    const first = (await manager.ensure("orb", 1))._unsafeUnwrap();
    expect((await manager.ensure("orb", 1))._unsafeUnwrap()).toBe(first);
    expect(closed).toEqual([]);
    await manager.ensure("orb", 2);
    expect((await manager.ensure("orb", 1)).isErr()).toBe(true);
    await manager.dispose("orb");
    expect((await manager.ensure("orb", 2)).isErr()).toBe(true);
    expect(closed).toEqual([1, 2]);
  });
});

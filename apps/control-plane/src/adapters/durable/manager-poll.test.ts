import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineTask, Harness, InboxDoc } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { RuntimeHealthSchema } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { err, errAsync, okAsync, ResultAsync } from "neverthrow";
import { Check } from "typebox/value";
import { expect, it, vi } from "vitest";
import type { RuntimeClientError } from "../../domain/errors.ts";
import { makeOrbRow } from "../../testkit/fixtures.ts";
import { DurableAgentPlane, type DurableAgentPlaneOptions } from "./manager.ts";
import { MemoryAgentPersistence } from "./memory-persistence.testkit.ts";

function gate<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const agentOptions = () => ({
  models: createModels(),
  registry: createRegistry(),
  env: new NodeExecutionEnv({ cwd: "/tmp" }),
  checkoutCommit: "commit",
  instructions: "",
});

async function fixture(options: Partial<DurableAgentPlaneOptions> = {}) {
  const deadlines: { controller: AbortController; budget: number; cancelled: boolean }[] = [];
  const clock = () =>
    deadlines.some((deadline) => deadline.controller.signal.aborted) ? 30_000 : 0;
  const caller = new (class extends NoSimulationTask {
    override monotonicNow() {
      return clock();
    }
  })("poll", false);
  const ended = gate<string>();
  const events: string[] = [];
  const persistence = new MemoryAgentPersistence();
  const runStartup: NonNullable<DurableAgentPlaneOptions["runStartup"]> = vi.fn((_id, run) =>
    run(
      new (class extends NoSimulationTask {
        override monotonicNow() {
          return clock();
        }
        override createDeadline(budget: number) {
          const deadline = { controller: new AbortController(), budget, cancelled: false };
          deadlines.push(deadline);
          return {
            signal: deadline.controller.signal,
            cancel: () => {
              deadline.cancelled = true;
            },
          };
        }
        override log(line: string) {
          events.push(line);
          if (line.includes("agent.poll_startup_finished")) ended.resolve(line);
        }
      })("startup", false),
    ),
  );
  const plane = (
    await DurableAgentPlane.create({
      persistence,
      openContext: () => okAsync(agentOptions()),
      runStartup,
      ...options,
    })
  )._unsafeUnwrap();
  const orb = makeOrbRow("orb", "project", "starting", { agentAdmissionVersion: 2 });
  return { caller, deadlines, ended, events, orb, persistence, plane, runStartup };
}

it("keeps one owned startup through poll cancellation, then reports actual ready", async () => {
  const entered = gate<AbortSignal>();
  const release = gate();
  const prepare = vi.fn<NonNullable<DurableAgentPlaneOptions["prepare"]>>(
    (_task, _orb, context) => {
      entered.resolve(context.signal);
      return ResultAsync.fromSafePromise(release.promise);
    },
  );
  const { caller, deadlines, ended, events, orb, plane, runStartup } = await fixture({ prepare });
  const firstPoll = new AbortController();
  const nextPoll = { signal: new AbortController().signal };
  try {
    const initial = (
      await plane.pollHealth(caller, orb, { signal: firstPoll.signal })
    )._unsafeUnwrap();
    expect(initial).toMatchObject({ status: "initializing", phase: "loading_session" });
    expect(Check(RuntimeHealthSchema, initial)).toBe(true);
    const startupSignal = await entered.promise;
    // The poll deadline is external; advancing it must not abort the owned open.
    firstPoll.abort();
    expect(startupSignal.aborted).toBe(false);
    expect(
      (await plane.pollHealth(caller, orb, { signal: firstPoll.signal }))._unsafeUnwrapErr().code,
    ).toBe("cancelled");
    expect((await plane.pollHealth(caller, orb, nextPoll))._unsafeUnwrap()).toEqual(initial);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(runStartup).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]?.[0]).not.toBe(caller);
    expect(deadlines.map(({ budget }) => budget)).toEqual([30_000]);
    release.resolve();
    await ended.promise;
    expect((await plane.pollHealth(caller, orb, nextPoll))._unsafeUnwrap().status).toBe("ready");
    expect(deadlines[0]?.cancelled).toBe(true);
    expect(events.filter((line) => line.includes("agent.poll_startup_finished"))).toHaveLength(1);
  } finally {
    release.resolve();
    await plane.close();
  }
});

it.each(["failed", "refusal"] as const)(
  "consumes a completed %s once before retrying",
  async (kind) => {
    const entered = gate();
    const release = gate();
    const refusal: RuntimeClientError =
      kind === "failed"
        ? {
            type: "runtime_client_error",
            code: "initialization_failed",
            answered: true,
            message: "clone refused",
            retryable: true,
            initializationError: {
              code: "clone_failed",
              message: "clone refused",
              retryable: true,
            },
          }
        : {
            type: "runtime_client_error",
            code: "history_integrity",
            answered: true,
            message: "typed refusal",
            retryable: false,
          };
    const openContext = vi
      .fn<DurableAgentPlaneOptions["openContext"]>()
      .mockImplementationOnce(() => {
        entered.resolve();
        return ResultAsync.fromSafePromise(release.promise).andThen(() => err(refusal));
      })
      .mockImplementation(() => okAsync(agentOptions()));
    const { caller, ended, orb, plane } = await fixture({ openContext });
    const context = { signal: new AbortController().signal };
    try {
      expect((await plane.pollHealth(caller, orb, context))._unsafeUnwrap().status).toBe(
        "initializing",
      );
      await entered.promise;
      release.resolve();
      await ended.promise;
      const result = await plane.pollHealth(caller, orb, context);
      if (kind === "failed")
        expect(result._unsafeUnwrap()).toMatchObject({
          status: "failed",
          error: refusal.initializationError,
        });
      else expect(result._unsafeUnwrapErr()).toBe(refusal);
      expect(openContext).toHaveBeenCalledTimes(1);
      expect((await plane.pollHealth(caller, orb, context))._unsafeUnwrap().status).toBe(
        "initializing",
      );
      // Explicit health joins the retry, rather than opening or invalidating a second owner.
      expect((await plane.health(caller, orb, context))._unsafeUnwrap().status).toBe("ready");
      expect(openContext).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve();
      await plane.close();
    }
  },
);

it("expires the owned budget, closes late composition, and never publishes it", async () => {
  const entered = gate<AbortSignal>();
  const release = gate();
  const closeResources = vi.fn(() => okAsync(undefined));
  const { caller, deadlines, ended, orb, plane } = await fixture({
    openContext: (_task, _orb, context) => {
      entered.resolve(context.signal);
      return ResultAsync.fromSafePromise(release.promise).map(() => ({
        ...agentOptions(),
        closeResources,
      }));
    },
  });
  const context = { signal: new AbortController().signal };
  try {
    await plane.pollHealth(caller, orb, context);
    const signal = await entered.promise;
    deadlines[0]?.controller.abort();
    expect(signal.aborted).toBe(true);
    expect((await plane.pollHealth(caller, orb, context))._unsafeUnwrap().status).toBe(
      "initializing",
    );
    release.resolve();
    const event = await ended.promise;
    expect(event).toContain("abort_origin=deadline");
    expect(event).toContain("duration_ms=30000");
    expect(event).toContain("compose_ms=30000");
    expect((await plane.pollHealth(caller, orb, context))._unsafeUnwrapErr()).toMatchObject({
      code: "cancelled",
      retryable: true,
    });
    expect(plane.session(orb.id)).toBeNull();
    expect(closeResources).toHaveBeenCalledTimes(1);
  } finally {
    release.resolve();
    await plane.close();
  }
});

it("keeps native work paused when the startup deadline fires at the idle boundary", async () => {
  const entered = gate();
  const release = gate();
  const first = gate<Harness>();
  const retry = gate<Harness>();
  const inferred = gate();
  const ran = vi.fn();
  const activateResources = vi.fn(() => () => undefined);
  const work = defineTask<null, { phase: "run" }, null>({
    name: "startup-retained-work",
    version: 1,
    initial: () => ({ phase: "run" }),
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
    phases: {
      run: async (_task, runtime, ctx) => {
        ran();
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
          ctx,
        );
      },
    },
  });
  const registry = () => {
    const value = createRegistry();
    value.install({ name: "startup-retained-work", tasks: [work] });
    return value;
  };
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  faux.setResponses([
    () => {
      inferred.resolve();
      return fauxAssistantMessage("flushed");
    },
  ]);
  const { caller, deadlines, ended, orb, persistence, plane } = await fixture({
    openContext: () =>
      okAsync({ ...agentOptions(), models, registry: registry(), activateResources }),
  });
  const context = { signal: new AbortController().signal };
  const storage = (await persistence.openOrb(orb.id, false))._unsafeUnwrap().storage;
  const nativeOpen = Harness.open;
  const seed = await nativeOpen(storage, { models, registry: registry() }, BACKGROUND_CONTEXT);
  const root = await seed.root(BACKGROUND_CONTEXT, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
  });
  const submissionId = await root.commit(async (tx) => {
    // Retain both runnable work and an orphan queued input in an idle root.
    const inbox = await tx.doc(InboxDoc, root.id);
    const queued = await tx.createSubmission({
      conversationId: root.id,
      requestId: "inbox:retained",
      type: "input",
      status: "queued",
    });
    inbox.items.push({
      id: queued.id,
      mode: "steer",
      content: [{ type: "text", text: "retained" }],
    });
    await tx.createTask(work, null, { ownership: { kind: "conversation" } });
    return queued.id;
  }, BACKGROUND_CONTEXT);
  await seed.close(BACKGROUND_CONTEXT);

  const open = vi
    .spyOn(Harness, "open")
    .mockImplementationOnce(async (storage, options, context) => {
      const parent = BACKGROUND_CONTEXT.telemetry;
      const harness = await nativeOpen(
        storage,
        {
          ...options,
          telemetry: {
            async startSpan(options, callback) {
              // The real submitMany has entered, but its idle-boundary commit has not.
              if (options.name === "pi.durable.submit") {
                entered.resolve();
                await release.promise;
              }
              return parent.startSpan(options, callback);
            },
          },
        },
        context,
      );
      first.resolve(harness);
      return harness;
    })
    .mockImplementation(async (...args) => {
      const harness = await nativeOpen(...args);
      retry.resolve(harness);
      return harness;
    });
  try {
    expect((await plane.pollHealth(caller, orb, context))._unsafeUnwrap().status).toBe(
      "initializing",
    );
    await entered.promise;
    deadlines[0]!.controller.abort();
    expect((await (await first.promise).inspect(BACKGROUND_CONTEXT)).scheduling).toBe("paused");
    release.resolve();
    expect(await ended.promise).toContain("abort_origin=deadline");
    expect((await plane.pollHealth(caller, orb, context))._unsafeUnwrapErr().code).toBe(
      "cancelled",
    );
    expect(ran).not.toHaveBeenCalled();
    expect(faux.state.callCount).toBe(0);
    expect(activateResources).not.toHaveBeenCalled();
    expect(await storage.submission(submissionId, BACKGROUND_CONTEXT)).toMatchObject({
      status: "queued",
    });

    expect((await plane.pollHealth(caller, orb, context))._unsafeUnwrap().status).toBe(
      "initializing",
    );
    // Do not call health or waitForIdle until activation has driven the provider call; both can resume work.
    await inferred.promise;
    await (await retry.promise).waitForIdle(BACKGROUND_CONTEXT);
    expect(await storage.submission(submissionId, BACKGROUND_CONTEXT)).toMatchObject({
      status: "done",
    });
    expect(ran).toHaveBeenCalledTimes(1);
    expect(faux.state.callCount).toBe(1);
    expect(activateResources).toHaveBeenCalledTimes(1);
  } finally {
    release.resolve();
    open.mockRestore();
    await plane.close();
  }
});

it("fences Stop, refuses stale callers and does not replace a slot before teardown joins", async () => {
  const entered = gate<AbortSignal>();
  const release = gate();
  const closing = gate();
  const drained = gate();
  const openContext = vi
    .fn<DurableAgentPlaneOptions["openContext"]>()
    .mockImplementationOnce((_task, _orb, context) => {
      entered.resolve(context.signal);
      return ResultAsync.fromSafePromise(release.promise).map(() => ({
        ...agentOptions(),
        closeResources: () => {
          closing.resolve();
          return ResultAsync.fromSafePromise(drained.promise);
        },
      }));
    })
    .mockImplementation(() => okAsync(agentOptions()));
  const { caller, orb, plane } = await fixture({ openContext });
  const context = { signal: new AbortController().signal };
  const current = { ...orb, agentAdmissionVersion: 4 };
  try {
    await plane.pollHealth(caller, orb, context);
    const started = await entered.promise;
    const stopping = plane.suspend(caller, orb.id, context, 3);
    expect(started.aborted).toBe(true);
    release.resolve();
    await closing.promise;
    expect((await plane.pollHealth(caller, current, context))._unsafeUnwrap().status).toBe(
      "initializing",
    );
    expect((await plane.pollHealth(caller, orb, context)).isErr()).toBe(true);
    expect(plane.session(orb.id)).toBeNull();
    expect(openContext).toHaveBeenCalledTimes(1);
    drained.resolve();
    expect((await stopping).isOk()).toBe(true);
    expect((await plane.pollHealth(caller, current, context))._unsafeUnwrap().status).toBe(
      "initializing",
    );
    expect((await plane.suspend(caller, orb.id, context, 3)).isOk()).toBe(true);
    expect((await plane.pollHealth(caller, orb, context)).isErr()).toBe(true);
    expect((await plane.health(caller, current, context))._unsafeUnwrap().status).toBe("ready");
    expect(openContext.mock.calls.map(([, row]) => row.agentAdmissionVersion)).toEqual([2, 4]);
  } finally {
    release.resolve();
    drained.resolve();
    await plane.close();
  }
});

it("shutdown joins an owned worker before closing persistence", async () => {
  const entered = gate<AbortSignal>();
  const release = gate();
  const { caller, ended, orb, persistence, plane } = await fixture({
    prepare: (_task, _orb, context) => {
      entered.resolve(context.signal);
      return ResultAsync.fromSafePromise(release.promise).andThen(() =>
        errAsync<undefined, RuntimeClientError>({
          type: "runtime_client_error",
          code: "cancelled",
          message: "fixture stopped",
          answered: true,
          retryable: true,
        }),
      );
    },
  });
  const close = vi.spyOn(persistence, "close");
  const context = { signal: new AbortController().signal };
  try {
    await plane.pollHealth(caller, orb, context);
    const started = await entered.promise;
    const closed = plane.close();
    expect(started.aborted).toBe(true);
    expect((await plane.pollHealth(caller, orb, context)).isErr()).toBe(true);
    expect(close).not.toHaveBeenCalled();
    release.resolve();
    expect((await closed).isOk()).toBe(true);
    expect(await ended.promise).toContain("abort_origin=shutdown");
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    release.resolve();
    await plane.close();
  }
});

it("fences lease loss during Harness startup before activation", async () => {
  const entered = gate();
  const release = gate();
  const activateResources = vi.fn(() => () => undefined);
  const { caller, ended, orb, persistence, plane } = await fixture({
    openContext: () =>
      okAsync({
        ...agentOptions(),
        activateResources,
        edge: (name) => {
          if (name !== "harness.opened") return okAsync(undefined);
          entered.resolve();
          return ResultAsync.fromSafePromise(release.promise);
        },
      }),
  });
  const context = { signal: new AbortController().signal };
  try {
    await plane.pollHealth(caller, orb, context);
    await entered.promise;
    persistence.revoke(orb.id);
    release.resolve();
    const event = await ended.promise;
    expect(event).toContain("abort_origin=lease");
    expect(event).toContain("harness_ms=");
    expect(activateResources).not.toHaveBeenCalled();
    expect(plane.session(orb.id)).toBeNull();
    expect((await plane.pollHealth(caller, orb, context)).isErr()).toBe(true);
  } finally {
    release.resolve();
    await plane.close();
  }
});

it.each(["clean", "failed", "owner-lost", "superseded", "manual"] as const)(
  "reports completed Sleep proof only for the current admission (%s)",
  async (outcome) => {
    const entered = gate();
    const release = gate();
    const failure = {
      type: "runtime_client_error",
      code: "history_unavailable",
      message: "resource drain failed",
      answered: true,
      retryable: false,
    } as const;
    const persistence = new MemoryAgentPersistence();
    if (outcome === "owner-lost") {
      const open = persistence.open.bind(persistence);
      vi.spyOn(persistence, "open").mockImplementation((...args) =>
        open(...args).map((lease) => ({
          ...lease,
          beginDrain: () =>
            okAsync({
              type: "owner_lost" as const,
              cause: {
                type: "authority_error" as const,
                code: "stale_owner" as const,
                message: "Agent ownership revoked",
              },
            }),
        })),
      );
    }
    const { caller, orb, plane, runStartup } = await fixture({
      persistence,
      openContext: () =>
        okAsync({
          ...agentOptions(),
          closeResources: () => {
            entered.resolve();
            return ResultAsync.fromSafePromise(release.promise).andThen(() =>
              outcome === "failed" ? errAsync(failure) : okAsync(undefined),
            );
          },
        }),
    });
    const context = { signal: new AbortController().signal };
    const sleeping = { ...orb, state: "stopping" as const, stopReason: "sleep" as const };
    const wake = { ...orb, agentAdmissionVersion: orb.agentAdmissionVersion + 1 };
    try {
      (await plane.health(caller, orb, context))._unsafeUnwrap();
      expect((await plane.pollHealth(caller, sleeping, context))._unsafeUnwrap().status).toBe(
        "ready",
      );
      const stopping = plane.suspend(
        caller,
        orb.id,
        context,
        orb.agentAdmissionVersion,
        outcome === "manual" ? undefined : "sleep",
      );
      await entered.promise;
      expect((await plane.pollHealth(caller, sleeping, context)).isErr()).toBe(true);
      const replacement = outcome === "superseded" ? plane.health(caller, wake, context) : null;
      release.resolve();

      const stopped = await stopping;
      if (outcome === "failed") {
        expect(stopped._unsafeUnwrapErr()).toBe(failure);
        expect((await plane.pollHealth(caller, sleeping, context))._unsafeUnwrapErr()).toBe(
          failure,
        );
        return;
      }
      stopped._unsafeUnwrap();
      if (outcome === "owner-lost")
        expect(
          (await plane.pollHealth(caller, sleeping, context))._unsafeUnwrapErr(),
        ).toMatchObject({
          message: "Agent ownership revoked",
        });
      if (outcome === "clean") {
        // Provider-stop retries do not repeat the agent close or erase its proof.
        (
          await plane.suspend(caller, orb.id, context, orb.agentAdmissionVersion, "sleep")
        )._unsafeUnwrap();
        expect((await plane.pollHealth(caller, sleeping, context))._unsafeUnwrap()).toEqual({
          status: "sleep_suspended",
        });
        expect((await plane.pollHealth(caller, orb, context)).isErr()).toBe(true);
        expect(runStartup).not.toHaveBeenCalled();
        (await plane.dispose(caller, orb.id, false, context))._unsafeUnwrap();
      }
      expect((await plane.pollHealth(caller, sleeping, context)).isErr()).toBe(true);
      if (replacement) {
        expect((await replacement)._unsafeUnwrap().status).toBe("ready");
        (
          await plane.suspend(caller, orb.id, context, orb.agentAdmissionVersion, "sleep")
        )._unsafeUnwrap();
        const latestSleep = { ...sleeping, agentAdmissionVersion: wake.agentAdmissionVersion };
        expect((await plane.pollHealth(caller, latestSleep, context))._unsafeUnwrap().status).toBe(
          "ready",
        );
      }
    } finally {
      release.resolve();
      await plane.close();
    }
  },
);

it("does not activate an admitted cold readonly owner and retires it before a fresh wake", async () => {
  const activateResources = vi.fn(() => () => undefined);
  const modes: (boolean | undefined)[] = [];
  const { caller, ended, orb, plane } = await fixture({
    openContext: (_task, _orb, _context, readOnly) => {
      modes.push(readOnly);
      return okAsync({ ...agentOptions(), activateResources });
    },
  });
  const stopped = { ...orb, state: "stopped" as const, stopReason: "manual" as const };
  const context = { signal: new AbortController().signal };
  try {
    await plane.pollHealth(caller, stopped, context);
    await ended.promise;
    expect((await plane.pollHealth(caller, stopped, context))._unsafeUnwrap().status).toBe("ready");
    expect(activateResources).not.toHaveBeenCalled();
    const waking = { ...orb, agentAdmissionVersion: orb.agentAdmissionVersion + 1 };
    await plane.pollHealth(caller, waking, context);
    expect((await plane.health(caller, waking, context))._unsafeUnwrap().status).toBe("ready");
    expect(modes).toEqual([true, false]);
    expect(activateResources).toHaveBeenCalledTimes(1);
  } finally {
    await plane.close();
  }
});

it("publishes the owner before native scheduling or resource activation", async () => {
  const context = { signal: new AbortController().signal };
  const visibility: boolean[] = [];
  let published = () => false;
  const { caller, orb, plane } = await fixture({
    openContext: () =>
      okAsync({
        ...agentOptions(),
        executionActive: () => true,
        activateResources: () => {
          visibility.push(published());
          return () => undefined;
        },
      }),
  });
  published = () => plane.executionActive(orb.id);
  const nativeOpen = Harness.open;
  const open = vi.spyOn(Harness, "open").mockImplementation(async (...args) => {
    const harness = await nativeOpen(...args);
    const nativeRoot = harness.root.bind(harness);
    vi.spyOn(harness, "root").mockImplementation(async (...args) => {
      const conversation = await nativeRoot(...args);
      const submitMany = conversation.submitMany.bind(conversation);
      vi.spyOn(conversation, "submitMany").mockImplementation((...args) => {
        if (args[0].length === 0) visibility.push(published());
        return submitMany(...args);
      });
      return conversation;
    });
    return harness;
  });
  try {
    await plane.pollHealth(caller, orb, context);
    expect((await plane.health(caller, orb, context))._unsafeUnwrap().status).toBe("ready");
    expect(visibility).toEqual([true, true]);
  } finally {
    open.mockRestore();
    await plane.close();
  }
});

it("fences replacements and fails Stop and shutdown if abandoned composition cannot drain", async () => {
  const entered = gate();
  const release = gate();
  const failure: RuntimeClientError = {
    type: "runtime_client_error",
    code: "history_unavailable",
    message: "resource drain failed",
    answered: true,
    retryable: false,
  };
  const openContext = vi.fn<DurableAgentPlaneOptions["openContext"]>().mockImplementation(() => {
    entered.resolve();
    return ResultAsync.fromSafePromise(release.promise).map(() => ({
      ...agentOptions(),
      closeResources: () => errAsync(failure),
    }));
  });
  const { caller, orb, persistence, plane } = await fixture({ openContext });
  const close = vi.spyOn(persistence, "close");
  const context = { signal: new AbortController().signal };
  try {
    await plane.pollHealth(caller, orb, context);
    await entered.promise;
    const stopping = plane.suspend(caller, orb.id, context, 3);
    const replacement = plane.health(caller, { ...orb, agentAdmissionVersion: 4 }, context);
    release.resolve();
    expect((await stopping)._unsafeUnwrapErr()).toBe(failure);
    expect((await replacement)._unsafeUnwrapErr()).toBe(failure);
    expect((await plane.close())._unsafeUnwrapErr()).toBe(failure);
    expect(openContext).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await plane.close();
  }
});

it("keeps an activation refusal visible while failed retirement fences new starts", async () => {
  const refusal: RuntimeClientError = {
    type: "runtime_client_error",
    code: "history_integrity",
    message: "inconsistent history",
    answered: true,
    retryable: false,
  };
  const cleanupFailure = {
    ...refusal,
    code: "history_unavailable" as const,
    message: "drain failed",
  };
  const openContext = vi.fn(() =>
    okAsync({
      ...agentOptions(),
      checkAdmission: () => errAsync(refusal),
      closeResources: () => errAsync(cleanupFailure),
    }),
  );
  const { caller, ended, orb, plane, runStartup } = await fixture({ openContext });
  const context = { signal: new AbortController().signal };
  try {
    expect((await plane.pollHealth(caller, orb, context))._unsafeUnwrap().status).toBe(
      "initializing",
    );
    await ended.promise;
    expect((await plane.pollHealth(caller, orb, context))._unsafeUnwrapErr()).toBe(refusal);
    expect((await plane.pollHealth(caller, orb, context))._unsafeUnwrapErr()).toBe(refusal);
    const replacement = { ...orb, agentAdmissionVersion: orb.agentAdmissionVersion + 1 };
    expect((await plane.health(caller, replacement, context))._unsafeUnwrapErr()).toBe(refusal);
    expect(openContext).toHaveBeenCalledTimes(1);
    expect(runStartup).toHaveBeenCalledTimes(1);
    expect(plane.session(orb.id)).toBeNull();
    expect((await plane.suspend(caller, orb.id, context))._unsafeUnwrapErr()).toBe(cleanupFailure);
    expect((await plane.close())._unsafeUnwrapErr()).toBe(cleanupFailure);
  } finally {
    await plane.close();
  }
});

it("does not use a warm owner after the queued waiter cancels", async () => {
  const { caller, orb, plane } = await fixture();
  const waiter = new AbortController();
  try {
    expect((await plane.health(caller, orb, { signal: new AbortController().signal })).isOk()).toBe(
      true,
    );
    const health = plane.health(caller, orb, { signal: waiter.signal });
    waiter.abort();
    expect((await health)._unsafeUnwrapErr()).toMatchObject({
      code: "cancelled",
      retryable: false,
    });
  } finally {
    await plane.close();
  }
});

it("reuses the same-version active owner for Sleep health", async () => {
  const revoke = vi.fn();
  const activateResources = vi.fn(() => revoke);
  const openContext = vi.fn(() => okAsync({ ...agentOptions(), activateResources }));
  const { caller, orb, plane } = await fixture({ openContext });
  const context = { signal: new AbortController().signal };
  const sleeping = { ...orb, state: "stopping" as const, stopReason: "sleep" as const };
  try {
    const running = (await plane.health(caller, orb, context))._unsafeUnwrap();
    expect((await plane.pollHealth(caller, sleeping, context))._unsafeUnwrap()).toEqual(running);
    expect((await plane.health(caller, sleeping, context))._unsafeUnwrap()).toEqual(running);
    expect(openContext).toHaveBeenCalledTimes(1);
    expect(activateResources).toHaveBeenCalledTimes(1);
    expect(revoke).not.toHaveBeenCalled();
  } finally {
    await plane.close();
  }
});

it("skips no-demand unload without joining or mutating a pending startup", async () => {
  const entered = gate<AbortSignal>();
  const release = gate();
  const { caller, ended, orb, plane } = await fixture({
    openContext: (_task, _orb, context) => {
      entered.resolve(context.signal);
      return ResultAsync.fromSafePromise(release.promise).map(agentOptions);
    },
  });
  const stopped = { ...orb, state: "stopped" as const };
  const context = { signal: new AbortController().signal };
  try {
    await plane.readSession(caller, stopped, context);
    await plane.pollHealth(caller, stopped, context);
    const startupSignal = await entered.promise;
    const unloaded = await Promise.race([
      Promise.resolve(plane.unload(caller, stopped, context)),
      new Promise<null>((resolve) => setImmediate(() => resolve(null))),
    ]);
    expect(unloaded?._unsafeUnwrap()).toBe(false);
    expect(startupSignal.aborted).toBe(false);
    release.resolve();
    await ended.promise;
    expect((await plane.unload(caller, stopped, context))._unsafeUnwrap()).toBe(true);
  } finally {
    release.resolve();
    await plane.close();
  }
});

it("cancels via a stable handle using the freshest pending admission without opening Harness", async () => {
  const entered = gate();
  const release = gate();
  const cancelPending = vi.fn<NonNullable<DurableAgentPlaneOptions["cancelPending"]>>(() =>
    okAsync("cancelled"),
  );
  const openContext = vi.fn(() => okAsync(agentOptions()));
  const { caller, orb, plane } = await fixture({
    cancelPending,
    openContext,
    prepare: () => {
      entered.resolve();
      return ResultAsync.fromSafePromise(release.promise);
    },
  });
  const current = { ...orb, agentAdmissionVersion: 3 };
  const context = { signal: new AbortController().signal };
  try {
    const handle = (await plane.readSession(caller, orb, context))._unsafeUnwrap();
    await plane.pollHealth(caller, orb, context);
    await entered.promise;
    await plane.pollHealth(caller, current, context);
    // A stale passive reader must not overwrite the cancellation authority.
    await plane.readSession(caller, orb, context);
    expect(
      (await handle.request("cancel", { type: "abort", operationId: "queued" }))._unsafeUnwrap(),
    ).toMatchObject({ type: "accepted", operationId: "queued" });
    expect(cancelPending).toHaveBeenCalledWith(caller, current, "queued");
    expect(openContext).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await plane.close();
  }
});

it.each(["cancelled", "definitive"] as const)(
  "delivers the %s prepare result to a joined executionReady waiter after the deadline",
  async (kind) => {
    const entered = gate();
    const release = gate();
    const failure: RuntimeClientError =
      kind === "cancelled"
        ? {
            type: "runtime_client_error",
            code: "cancelled",
            message: "resource acquire cancelled",
            answered: true,
            retryable: false,
          }
        : {
            type: "runtime_client_error",
            code: "initialization_failed",
            message: "resource acquire refused",
            answered: true,
            retryable: false,
            initializationError: {
              code: "resource_acquisition_failed",
              message: "resource acquire refused",
              retryable: false,
            },
          };
    const { caller, deadlines, orb, plane } = await fixture({
      prepare: () => {
        entered.resolve();
        return ResultAsync.fromSafePromise(release.promise).andThen(() => err(failure));
      },
    });
    const context = { signal: new AbortController().signal };
    try {
      await plane.pollHealth(caller, orb, context);
      await entered.promise;
      const waiting = plane.executionReady(caller, orb, context);
      deadlines[0]?.controller.abort();
      release.resolve();
      expect((await waiting)._unsafeUnwrapErr()).toMatchObject(
        kind === "cancelled" ? { code: "cancelled", retryable: true } : failure,
      );
    } finally {
      release.resolve();
      await plane.close();
    }
  },
);

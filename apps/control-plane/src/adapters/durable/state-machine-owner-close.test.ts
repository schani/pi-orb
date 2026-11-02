import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { expect, it } from "vitest";
import { DurableAgent } from "./agent.ts";
import { durableError, OrbAgentManager } from "./manager.ts";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each(["suspend", "dispose", "close"] as const)(
  "%s retains a real Harness cleanup failure from an admitted opening",
  async (operation) => {
    const opened = barrier();
    const returnOwner = barrier();
    const cleanupFailure = durableError("Owner resource release unavailable", true);
    let resourceCloseCalls = 0;
    const edges: { code: string; facts: Readonly<Record<string, string | number | boolean>> }[] =
      [];
    let owner: DurableAgent | undefined;
    const manager = new OrbAgentManager<DurableAgent>({
      open: () =>
        DurableAgent.open({
          orbId: "orb",
          storage: new MemoryStorage(),
          models: createModels(),
          registry: createRegistry(),
          env: new NodeExecutionEnv({ cwd: "/tmp" }),
          checkoutCommit: null,
          instructions: "instructions",
          edge: (code, facts) => {
            edges.push({ code, facts });
            return okAsync(undefined);
          },
          closeResources: () => {
            resourceCloseCalls++;
            return errAsync(cleanupFailure);
          },
        }).andThen((agent) => {
          owner = agent;
          opened.resolve();
          return ResultAsync.fromSafePromise(returnOwner.promise).map(() => agent);
        }),
      close: (agent) => agent.close(),
      revoke: (agent) => agent.revoke(),
    });
    const opening = manager.ensure("orb", 1);
    try {
      await opened.promise;
      const retiring = operation === "close" ? manager.close() : manager[operation]("orb");
      returnOwner.resolve();
      const admission = await opening;
      const retirement = await retiring;
      expect(admission.isErr()).toBe(true);
      if (admission.isErr()) expect(admission.error).toBe(cleanupFailure);
      expect(resourceCloseCalls).toBe(1);
      expect(owner?.accepting()).toBe(false);
      expect(edges).toContainEqual({
        code: "harness.resources_close_failed",
        facts: expect.objectContaining({ close_outcome: "failed", failed_stage: "resources" }),
      });
      expect(retirement.isErr(), "retirement must not report success after cleanup failed").toBe(
        true,
      );
      if (retirement.isErr()) expect(retirement.error).toBe(cleanupFailure);
    } finally {
      returnOwner.resolve();
      await opening;
      await owner?.close();
      await manager.close();
    }
  },
);

it("retains the same cleanup failure when the owner was already published", async () => {
  const cleanupFailure = durableError("Owner resource release unavailable", true);
  const manager = new OrbAgentManager<DurableAgent>({
    open: () =>
      DurableAgent.open({
        orbId: "orb",
        storage: new MemoryStorage(),
        models: createModels(),
        registry: createRegistry(),
        env: new NodeExecutionEnv({ cwd: "/tmp" }),
        checkoutCommit: null,
        instructions: "instructions",
        closeResources: () => errAsync(cleanupFailure),
      }),
    close: (agent) => agent.close(),
    revoke: (agent) => agent.revoke(),
  });
  try {
    (await manager.ensure("orb", 1))._unsafeUnwrap();
    expect((await manager.close())._unsafeUnwrapErr()).toBe(cleanupFailure);
  } finally {
    await manager.close();
  }
});

it("blocks replacement and rejoins failed retirement after opening was superseded", async () => {
  const opened = barrier();
  const returnOwner = barrier();
  const cleanupEntered = barrier();
  const finishCleanup = barrier();
  const cleanupFailure = durableError("Owner resource release unavailable", true);
  let opens = 0;
  let resourceCloseCalls = 0;
  let owner: DurableAgent | undefined;
  const manager = new OrbAgentManager<DurableAgent>({
    open: () => {
      opens++;
      return DurableAgent.open({
        orbId: "orb",
        storage: new MemoryStorage(),
        models: createModels(),
        registry: createRegistry(),
        env: new NodeExecutionEnv({ cwd: "/tmp" }),
        checkoutCommit: null,
        instructions: "instructions",
        closeResources: () => {
          resourceCloseCalls++;
          cleanupEntered.resolve();
          return ResultAsync.fromSafePromise(finishCleanup.promise).andThen(() =>
            errAsync(cleanupFailure),
          );
        },
      }).andThen((agent) => {
        owner = agent;
        opened.resolve();
        return ResultAsync.fromSafePromise(returnOwner.promise).map(() => agent);
      });
    },
    close: (agent) => agent.close(),
    revoke: (agent) => agent.revoke(),
  });
  const opening = manager.ensure("orb", 1);
  try {
    await opened.promise;
    const replacement = manager.ensure("orb", 2);
    returnOwner.resolve();
    await cleanupEntered.promise;
    expect(manager.get("orb")).toBeNull();
    expect(opens).toBe(1);
    finishCleanup.resolve();
    expect((await opening)._unsafeUnwrapErr()).toBe(cleanupFailure);
    const replaced = await replacement;
    expect(opens, "failed retirement must block replacement").toBe(1);
    expect(replaced._unsafeUnwrapErr()).toBe(cleanupFailure);
    expect(manager.get("orb")).toBeNull();
    expect((await manager.ensure("orb", 2, undefined, true))._unsafeUnwrapErr()).toBe(
      cleanupFailure,
    );
    expect((await manager.suspend("orb"))._unsafeUnwrapErr()).toBe(cleanupFailure);
    expect((await manager.unload("orb", () => okAsync(true)))._unsafeUnwrapErr()).toBe(
      cleanupFailure,
    );
    expect((await manager.dispose("orb"))._unsafeUnwrapErr()).toBe(cleanupFailure);
    expect((await manager.close())._unsafeUnwrapErr()).toBe(cleanupFailure);
    expect(opens).toBe(1);
    expect(resourceCloseCalls).toBe(1);
  } finally {
    returnOwner.resolve();
    finishCleanup.resolve();
    await opening;
    await owner?.close();
    await manager.close();
  }
});

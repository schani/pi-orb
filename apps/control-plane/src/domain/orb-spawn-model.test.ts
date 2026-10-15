import { NoSimulationTask } from "determined";
import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow } from "../testkit/fixtures.ts";
import type { CheckSpawnModel } from "./orb-spawn-model.ts";
import { spawnOrb } from "./orb-spawning.ts";

const task = new NoSimulationTask("spawn-model", false);
describe("spawn initial settings", () => {
  it.each([
    ["claude", { provider: "openai-codex", id: "gpt-6.1-sol" }, "pi"],
    ["pi", { provider: "claude", id: "opus" }, "claude"],
    ["claude", undefined, "claude"],
  ] as const)("accepts %j with %j as %s", async (harness, model, expected) => {
    const h = makeHarness();
    const caller = makeOrbRow("source", "project", "running", {
      harness,
      runtimeTokenHash: "token",
      userTimeZone: "America/Los_Angeles",
    });
    h.store.seedProject(makeProjectRow("project"));
    h.store.seedOrb(caller);
    const checkSpawnModel = vi.fn<CheckSpawnModel>(() => okAsync(undefined));
    const deps = { ...h.deps, checkSpawnModel };
    const request = { prompt: "work", ...(model === undefined ? {} : { model }) };
    expect((await spawnOrb(task, deps, caller, "child", request)).isOk()).toBe(true);
    expect(h.store.orbSnapshot("child")).toMatchObject({
      harness: expected,
      initialModel: model ?? null,
      userTimeZone: caller.userTimeZone,
    });
    checkSpawnModel.mockImplementation(() =>
      errAsync({
        type: "spawn_model_error",
        reason: "disconnected",
        message: "Disconnected.",
      }),
    );
    expect((await spawnOrb(task, deps, caller, "child", request)).isOk()).toBe(true);
    const conflict = await spawnOrb(task, deps, caller, "child", {
      ...request,
      model: { provider: "claude", id: "different-model" },
    });
    expect(conflict.isErr() && conflict.error.type).toBe("spawn_conflict");
    expect(checkSpawnModel).toHaveBeenCalledTimes(model === undefined ? 0 : 1);
    expect(h.store.messageSnapshots("child")).toHaveLength(1);
  });
  it.each(["invalid", "disconnected", "unavailable"] as const)(
    "rejects %s before acceptance",
    async (reason) => {
      const h = makeHarness();
      const caller = makeOrbRow("source", "project", "running", { runtimeTokenHash: "token" });
      h.store.seedProject(makeProjectRow("project"));
      h.store.seedOrb(caller);
      const nudge = vi.spyOn(h.deps.control, "nudgeNextAttemptAt");
      const result = await spawnOrb(
        task,
        {
          ...h.deps,
          checkSpawnModel: () =>
            errAsync({ type: "spawn_model_error", reason, message: "Unavailable model." }),
        },
        caller,
        "child",
        { prompt: "work", model: { provider: "claude", id: "opus" } },
      );
      expect(result._unsafeUnwrapErr()).toMatchObject({ type: "spawn_model_error", reason });
      expect(h.store.orbSnapshot("child")).toBeNull();
      expect((await h.store.getSpawnCaller(task, "child"))._unsafeUnwrap()).toBeNull();
      expect(h.store.messageSnapshots("child")).toHaveLength(0);
      expect(nudge).not.toHaveBeenCalled();
    },
  );
  it("fences owner changes during availability lookup", async () => {
    const h = makeHarness();
    const caller = makeOrbRow("source", "project", "running", { runtimeTokenHash: "token" });
    h.store.seedProject(makeProjectRow("project"));
    h.store.seedOrb(caller);
    const result = await spawnOrb(
      task,
      {
        ...h.deps,
        checkSpawnModel: () => {
          h.store.seedProject({ ...makeProjectRow("project"), ownerUserId: "replacement" });
          return okAsync(undefined);
        },
      },
      caller,
      "child",
      { prompt: "work", model: { provider: "claude", id: "opus" } },
    );
    expect(result._unsafeUnwrapErr()).toMatchObject({ type: "spawn_conflict" });
    expect(h.store.orbSnapshot("child")).toBeNull();
  });
});

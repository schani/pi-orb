import { NoSimulationTask } from "determined";
import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow } from "../testkit/fixtures.ts";
import type { SpawnModels } from "./orb-spawn-model.ts";
import { spawnOrb } from "./orb-spawning.ts";

const sol = { provider: "openai-codex", id: "gpt-6.1-sol", name: "Sol", thinkingLevels: [] };
const opus = { provider: "claude", id: "opus", name: "Opus", thinkingLevels: [] };
const catalog = { models: [sol, opus], disconnected: [] };

const task = new NoSimulationTask("spawn-model", false);
function seed(harness: "pi" | "claude" = "pi") {
  const h = makeHarness();
  const source = makeOrbRow("source", "project", "running", {
    harness,
    runtimeTokenHash: "token",
    userTimeZone: "America/Los_Angeles",
  });
  h.store.seedProject(makeProjectRow("project"));
  h.store.seedOrb(source);
  return { ...h, source };
}

describe("spawn model admission", () => {
  for (const [harness, model, expected] of [
    ["claude", "Sol", "pi"],
    ["pi", { provider: "claude", id: "opus" }, "claude"],
    ["claude", undefined, "claude"],
  ] as const) {
    it(`selects ${expected} from ${JSON.stringify(model)}`, async () => {
      const h = seed(harness);
      const lookup = vi.fn<SpawnModels["read"]>(() => okAsync(catalog));
      const accepted = await spawnOrb(
        task,
        { ...h.deps, spawnModels: { read: lookup } },
        h.source,
        "child",
        { prompt: "work", ...(model === undefined ? {} : { model }) },
      );
      expect(accepted.isOk()).toBe(true);
      expect(h.store.orbSnapshot("child")).toMatchObject({
        harness: expected,
        userTimeZone: h.source.userTimeZone,
        initialModel:
          model === undefined
            ? null
            : expected === "pi"
              ? { provider: sol.provider, id: sol.id }
              : { provider: opus.provider, id: opus.id },
      });
      expect(lookup).toHaveBeenCalledTimes(model === undefined ? 0 : 1);
    });
  }

  for (const [model, reply, reason] of [
    ["unknown", okAsync(catalog), "invalid"],
    [
      "Sol",
      errAsync({
        type: "spawn_model_error" as const,
        reason: "unavailable" as const,
        message: "catalog unavailable",
      }),
      "unavailable",
    ],
  ] as const) {
    it(`rejects ${reason} without child or nudge`, async () => {
      const h = seed();
      const nudge = vi.spyOn(h.deps.control, "nudgeNextAttemptAt");
      const rejected = await spawnOrb(
        task,
        { ...h.deps, spawnModels: { read: () => reply } },
        h.source,
        "child",
        { prompt: "work", model },
      );
      expect(rejected.isErr() && rejected.error).toMatchObject({
        type: "spawn_model_error",
        reason,
      });
      expect((await h.store.getSpawnCaller(task, "child"))._unsafeUnwrap()).toBeNull();
      expect(h.store.orbSnapshot("child")).toBeNull();
      expect(h.store.messageSnapshots("child")).toHaveLength(0);
      expect(nudge).not.toHaveBeenCalled();
    });
  }

  it("replays an accepted alias without catalog access; changed model conflicts", async () => {
    const h = seed();
    const lookup = vi.fn<SpawnModels["read"]>(() => okAsync(catalog));
    const deps = { ...h.deps, spawnModels: { read: lookup } };
    const request = { prompt: "work", model: "Sol" };
    expect((await spawnOrb(task, deps, h.source, "child", request)).isOk()).toBe(true);
    (
      await h.store.setOrbName(task, {
        orbId: "child",
        name: "changed",
        now: task.wallNow(),
        onlyIfNull: false,
      })
    )._unsafeUnwrap();
    h.store.seedProject({ ...makeProjectRow("project"), ownerUserId: "new-owner" });
    lookup.mockImplementation(() =>
      errAsync({
        type: "spawn_model_error",
        reason: "disconnected",
        message: "disconnected",
      }),
    );
    expect((await spawnOrb(task, deps, h.source, "child", request)).isOk()).toBe(true);
    const conflict = await spawnOrb(task, deps, h.source, "child", { ...request, model: "Opus" });
    expect(conflict.isErr() && conflict.error.type).toBe("spawn_conflict");
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(h.store.messageSnapshots("child")).toHaveLength(1);
  });

  it.each(["replacement", "stop", "project-deletion", "owner-change"] as const)(
    "refences %s after catalog lookup",
    async (mutation) => {
      const h = seed();
      const source = h.source;
      const deps = {
        ...h.deps,
        spawnModels: {
          read: () => {
            if (mutation === "replacement")
              h.store.seedOrb({ ...source, runtimeTokenHash: "replacement", hostIncarnation: 1 });
            else if (mutation === "stop")
              h.store.seedOrb({ ...source, state: "stopped", runtimeTokenHash: null });
            else if (mutation === "owner-change")
              h.store.seedProject({ ...makeProjectRow("project"), ownerUserId: "new-owner" });
            else h.store.seedProject({ ...makeProjectRow("project"), state: "deleting" });
            return okAsync(catalog);
          },
        },
      };
      const rejected = await spawnOrb(task, deps, source, "child", {
        prompt: "work",
        model: "Opus",
      });
      expect(rejected.isErr() && rejected.error.type).toBe("spawn_conflict");
      expect(h.store.orbSnapshot("child")).toBeNull();
      expect(h.store.messageSnapshots("child")).toHaveLength(0);
    },
  );
});

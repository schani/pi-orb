import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow } from "../testkit/fixtures.ts";
import { runDst } from "../testkit/sim.ts";
import type { SpawnModels } from "./orb-spawn-model.ts";
import { spawnOrb } from "./orb-spawning.ts";

const sol = { provider: "openai-codex", id: "gpt-6.1-sol", name: "Sol", thinkingLevels: [] };
const opus = { provider: "claude", id: "opus", name: "Opus", thinkingLevels: [] };
const catalog = { models: [sol, opus], disconnected: [] };

describe("spawn model admission", () => {
  for (const [harness, model, expected] of [
    ["claude", "Sol", "pi"],
    ["pi", { provider: "claude", id: "opus" }, "claude"],
    ["pi", "claude/opus", "claude"],
    ["claude", undefined, "claude"],
  ] as const) {
    it(`selects ${expected} from ${JSON.stringify(model)}`, async () => {
      await runDst(
        { name: `spawn-model-${expected}-${typeof model}`, iterations: 1 },
        async (sim) => {
          const h = makeHarness();
          const source = makeOrbRow("source", "project", "running", {
            harness,
            runtimeTokenHash: "token",
            userTimeZone: "America/Los_Angeles",
          });
          h.store.seedProject(makeProjectRow("project"));
          h.store.seedOrb(source);
          const lookup = vi.fn<SpawnModels["read"]>(() => okAsync(catalog));
          const result = await sim.runTasks([
            {
              name: "spawn",
              f: async (task) => {
                const accepted = await spawnOrb(
                  task,
                  { ...h.deps, spawnModels: { read: lookup } },
                  source,
                  "child",
                  { prompt: "work", ...(model === undefined ? {} : { model }) },
                );
                expect(accepted.isOk()).toBe(true);
              },
            },
          ]);
          expect(result.isOk()).toBe(true);
          expect(h.store.orbSnapshot("child")).toMatchObject({
            harness: expected,
            userTimeZone: source.userTimeZone,
            initialModel:
              model === undefined
                ? null
                : expected === "pi"
                  ? { provider: sol.provider, id: sol.id }
                  : { provider: opus.provider, id: opus.id },
          });
          expect(lookup).toHaveBeenCalledTimes(model === undefined ? 0 : 1);
        },
      );
    });
  }

  for (const [model, reply, reason] of [
    ["unknown", okAsync(catalog), "invalid"],
    [
      "Fable",
      errAsync({
        type: "spawn_model_error" as const,
        reason: "unadvertised" as const,
        message: "Model is not advertised.",
      }),
      "unadvertised",
    ],
    ["claude/retired", okAsync(catalog), "invalid"],
    ["Opus", okAsync({ models: [opus], disconnected: ["claude"] }), "disconnected"],
    ["Sol", okAsync({ models: [sol, { ...opus, name: "Sol" }], disconnected: [] }), "ambiguous"],
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
      await runDst({ name: `spawn-model-reject-${reason}`, iterations: 1 }, async (sim) => {
        const h = makeHarness();
        const source = makeOrbRow("source", "project", "running", { runtimeTokenHash: "token" });
        h.store.seedProject(makeProjectRow("project"));
        h.store.seedOrb(source);
        const nudge = vi.spyOn(h.deps.control, "nudgeNextAttemptAt");
        const result = await sim.runTasks([
          {
            name: "spawn",
            f: async (task) => {
              const rejected = await spawnOrb(
                task,
                { ...h.deps, spawnModels: { read: () => reply } },
                source,
                "child",
                { prompt: "work", model },
              );
              expect(rejected.isErr()).toBe(true);
              if (rejected.isErr())
                expect(rejected.error).toMatchObject({ type: "spawn_model_error", reason });
              expect((await h.store.getSpawnCaller(task, "child"))._unsafeUnwrap()).toBeNull();
            },
          },
        ]);
        expect(result.isOk()).toBe(true);
        expect(h.store.orbSnapshot("child")).toBeNull();
        expect(h.store.messageSnapshots("child")).toHaveLength(0);
        expect(nudge).not.toHaveBeenCalled();
      });
    });
  }

  it("replays an accepted alias without catalog access; changed model conflicts", async () => {
    await runDst({ name: "spawn-model-replay", iterations: 1 }, async (sim) => {
      const h = makeHarness();
      const source = makeOrbRow("source", "project", "running", { runtimeTokenHash: "token" });
      h.store.seedProject(makeProjectRow("project"));
      h.store.seedOrb(source);
      const lookup = vi.fn<SpawnModels["read"]>(() => okAsync(catalog));
      const deps = { ...h.deps, spawnModels: { read: lookup } };
      const result = await sim.runTasks([
        {
          name: "spawn",
          f: async (task) => {
            expect(
              (
                await spawnOrb(task, deps, source, "child", { prompt: "work", model: "Sol" })
              ).isOk(),
            ).toBe(true);
            await h.store.setOrbName(task, {
              orbId: "child",
              name: "changed",
              now: task.wallNow(),
              onlyIfNull: false,
            });
            h.store.seedProject({ ...makeProjectRow("project"), ownerUserId: "new-owner" });
            lookup.mockImplementation(() =>
              errAsync({
                type: "spawn_model_error",
                reason: "disconnected",
                message: "disconnected",
              }),
            );
            expect(
              (
                await spawnOrb(task, deps, source, "child", { prompt: "work", model: "Sol" })
              ).isOk(),
            ).toBe(true);
            const conflict = await spawnOrb(task, deps, source, "child", {
              prompt: "work",
              model: "Opus",
            });
            expect(conflict.isErr() && conflict.error.type).toBe("spawn_conflict");
          },
        },
      ]);
      expect(result.isOk()).toBe(true);
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(h.store.messageSnapshots("child")).toHaveLength(1);
    });
  });

  it.each(["replacement", "stop", "project-deletion", "owner-change"] as const)(
    "refences %s after asynchronous catalog lookup",
    async (mutation) => {
      await runDst(
        { name: `spawn-model-revoked-lookup-${mutation}`, iterations: 20 },
        async (sim) => {
          const h = makeHarness();
          const source = makeOrbRow("source", "project", "running", { runtimeTokenHash: "token" });
          h.store.seedProject(makeProjectRow("project"));
          h.store.seedOrb(source);
          const result = await sim.runTasks([
            {
              name: "spawn",
              f: async (task) => {
                const deps = {
                  ...h.deps,
                  spawnModels: {
                    read: () =>
                      ResultAsync.fromSafePromise(
                        (async () => {
                          await task.sleep(1, "catalog lookup pending");
                          if (mutation === "replacement")
                            h.store.seedOrb({
                              ...source,
                              runtimeTokenHash: "replacement",
                              hostIncarnation: 1,
                            });
                          else if (mutation === "stop")
                            h.store.seedOrb({
                              ...source,
                              state: "stopped",
                              runtimeTokenHash: null,
                            });
                          else if (mutation === "owner-change")
                            h.store.seedProject({
                              ...makeProjectRow("project"),
                              ownerUserId: "new-owner",
                            });
                          else
                            h.store.seedProject({
                              ...makeProjectRow("project"),
                              state: "deleting",
                            });
                          return catalog;
                        })(),
                      ),
                  },
                };
                const rejected = await spawnOrb(task, deps, source, "child", {
                  prompt: "work",
                  model: "Opus",
                });
                expect(rejected.isErr() && rejected.error.type).toBe("spawn_conflict");
              },
            },
          ]);
          expect(result.isOk()).toBe(true);
          expect(h.store.orbSnapshot("child")).toBeNull();
          expect(h.store.messageSnapshots("child")).toHaveLength(0);
        },
      );
    },
  );
});

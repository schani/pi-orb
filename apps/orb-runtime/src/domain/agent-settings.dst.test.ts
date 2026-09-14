import type { AgentSettings } from "@pi-orb/protocol";
import { err, ok, type Result } from "neverthrow";
import { expect, it } from "vitest";
import { runDst } from "../testkit/sim.ts";
import { AgentSettingsController } from "./agent-settings.ts";

it("DST: timeout returns a failure but a late setter cannot reopen input or publish success", async () => {
  await runDst({ name: "agent-settings-late-completion", iterations: 10 }, async (sim) => {
    const result = await sim.runTasks([
      {
        name: "timeout",
        f: async (task) => {
          let finish: (
            value: Result<AgentSettings, { type: "settings_error"; message: string }>,
          ) => void = () => {};
          const pending = new Promise<
            Result<AgentSettings, { type: "settings_error"; message: string }>
          >((resolve) => {
            finish = resolve;
          });
          const controller = new AgentSettingsController({
            task,
            initial,
            models,
            isIdle: () => true,
            timeoutMs: 5,
            apply: () => pending,
            publish: () => {},
          });
          expect(
            (await controller.change({ type: "set_thinking", thinkingLevel: "low" })).isErr(),
          ).toBe(true);
          finish(ok(initial));
          await task.checkpoint("late SDK completion");
          expect(controller.blocksInput).toBe(true);
          expect(controller.view.settings).toEqual(initial);
        },
      },
    ]);
    if (result.isErr()) throw result.error;
  });
});

it("DST: unchanged auth rejection leaves input usable; SDK observations never expose a pending mutation", async () => {
  await runDst({ name: "settings-auth-and-observation", iterations: 10 }, async (sim) => {
    const result = await sim.runTasks([
      {
        name: "auth",
        f: async (task) => {
          const controller = new AgentSettingsController({
            task,
            initial,
            models,
            isIdle: () => true,
            apply: async () => {
              controller.observe({ ...initial, thinkingLevel: "low" });
              expect(controller.view.settings).toEqual(initial);
              return err({ type: "settings_error", message: "Auth unavailable", unchanged: true });
            },
            publish: () => {},
          });
          expect(
            (await controller.change({ type: "set_thinking", thinkingLevel: "low" })).isErr(),
          ).toBe(true);
          expect(controller.blocksInput).toBe(false);
          controller.observe({ ...initial, thinkingLevel: "low" });
          expect(controller.view.settings.thinkingLevel).toBe("low");
        },
      },
    ]);
    if (result.isErr()) throw result.error;
  });
});

const initial = { model: { provider: "openai-codex", id: "a" }, thinkingLevel: "high" as const };
const models = [{ ...initial.model, name: "A", thinkingLevels: ["low" as const, "high" as const] }];

it("DST: claims input admission before awaiting, publishes only stable state, and restores disk after lost reply", async () => {
  await runDst({ name: "agent-settings-admission", iterations: 30 }, async (sim) => {
    const result = await sim.runTasks([
      {
        name: "settings",
        f: async (task) => {
          let disk = initial;
          let writes = 0;
          let agentBusy = false;
          const events: string[] = [];
          const controller = new AgentSettingsController({
            task,
            initial,
            models,
            isIdle: () => !agentBusy,
            apply: async (action) => {
              await task.checkpoint("before native settings write");
              expect(controller.blocksInput).toBe(true);
              expect(controller.view.settings).toEqual(initial);
              expect(controller.view.writable).toBe(false);
              disk = {
                ...disk,
                thinkingLevel: action.type === "set_thinking" ? action.thinkingLevel : "high",
              } as typeof initial;
              writes++;
              await task.checkpoint("after durability before response");
              return ok(disk);
            },
            publish: (view) => events.push(`${view.settings.thinkingLevel}:${view.writable}`),
          });
          const first = controller.change({ type: "set_thinking", thinkingLevel: "low" });
          expect(controller.blocksInput).toBe(true);
          expect(
            (await controller.change({ type: "set_thinking", thinkingLevel: "high" })).isErr(),
          ).toBe(true);
          expect((await first).isOk()).toBe(true);
          expect(writes).toBe(1);
          expect(events).toEqual(["high:false", "low:true"]);
          expect(controller.blocksInput).toBe(false);
          const rebooted = new AgentSettingsController({
            task,
            initial: disk,
            models,
            isIdle: () => true,
            apply: async () => {
              writes++;
              return ok(disk);
            },
            publish: () => {},
          });
          expect(rebooted.view.settings.thinkingLevel).toBe("low");
          expect(writes).toBe(1);
          agentBusy = true;
          expect(
            (await controller.change({ type: "set_thinking", thinkingLevel: "high" })).isErr(),
          ).toBe(true);
          expect(writes).toBe(1);
        },
      },
    ]);
    if (result.isErr()) throw result.error;
  });
});

it("DST: a partial setter failure never releases input for an inconsistent session", async () => {
  await runDst({ name: "agent-settings-partial-failure", iterations: 10 }, async (sim) => {
    const result = await sim.runTasks([
      {
        name: "failure",
        f: async (task) => {
          const controller = new AgentSettingsController({
            task,
            initial,
            models,
            isIdle: () => true,
            apply: async () => {
              await task.checkpoint("native append failed after memory mutation");
              return err({ type: "settings_error", message: "disk failed" });
            },
            publish: () => {},
          });
          expect(
            (await controller.change({ type: "set_thinking", thinkingLevel: "low" })).isErr(),
          ).toBe(true);
          expect(controller.blocksInput).toBe(true);
          expect(controller.view.writable).toBe(false);
          expect(controller.view.settings).toEqual(initial);
        },
      },
    ]);
    if (result.isErr()) throw result.error;
  });
});

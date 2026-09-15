import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSettings } from "@pi-orb/protocol";
import { ok, okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { AgentSettingsController } from "../domain/agent-settings.ts";
import { decideRequest } from "../domain/requests.ts";
import { MemoryIdleStopFence } from "../testkit/idle-stop-fence.ts";
import { runDst } from "../testkit/sim.ts";
import { PiOrbAgent, type PiSession } from "./agent.ts";

it.each([false, true])(
  "settings and idle-stop admission exclude each other (stop first=%s)",
  async (stopFirst) => {
    await runDst({ name: `settings-idle-stop-${stopFirst}`, iterations: 30 }, async (sim) => {
      const result = await sim.runTasks([
        {
          name: "runtime",
          f: async (task) => {
            const fence = new MemoryIdleStopFence();
            const agent = new PiOrbAgent({
              orbId: "settings-fence",
              repositoryUrl: "https://example.com/repo",
              workDir: "/test",
              skillsDir: null,
              broker: null,
              executionId: "execution",
              idleStopFence: fence,
            });
            const initial: AgentSettings = {
              model: { provider: "test", id: "model" },
              thinkingLevel: "high",
            };
            const action = { type: "set_thinking", thinkingLevel: "low" } as const;
            let writes = 0;
            const preparations: unknown[] = [];
            const childAdmissions: boolean[] = [];
            const controller = new AgentSettingsController({
              task,
              initial,
              models: [{ ...initial.model, name: "Model", thinkingLevels: ["low", "high"] }],
              isIdle: () => agent.gateView().activity === "idle",
              publish: () => undefined,
              apply: async () => {
                await task.checkpoint("settings ownership retained before persistence");
                if (!stopFirst) {
                  preparations.push(
                    agent.prepareIdleStop(),
                    fence.read(),
                    agent.gateView().acceptingWork,
                  );
                  const child = agent.admitSubagent("during-settings");
                  childAdmissions.push(child.isErr());
                  if (child.isOk()) agent.releaseSubagent(child.value);
                }
                writes++;
                return ok({ ...initial, thinkingLevel: "low" });
              },
            });
            agent.attachSession(
              { isIdle: true, subscribe: () => () => undefined } as unknown as PiSession,
              SessionManager.inMemory("/test"),
              { summarize: () => okAsync("") },
              controller,
            );
            await task.checkpoint("before either admission claim");
            if (stopFirst) {
              expect(agent.prepareIdleStop()._unsafeUnwrap()).toBe(true);
              expect(decideRequest(agent.gateView(), action)).toMatchObject({
                type: "reject",
                code: "busy",
              });
              expect((await agent.changeSettings(action)).isErr()).toBe(true);
              expect(writes).toBe(0);
            } else {
              expect((await agent.changeSettings(action)).isOk()).toBe(true);
              expect(preparations).toEqual([ok(false), ok(null), true]);
              expect(childAdmissions).toEqual([true]);
              expect(writes).toBe(1);
              expect(agent.prepareIdleStop()._unsafeUnwrap()).toBe(true);
            }
            expect(fence.read()._unsafeUnwrap()).toBe("host:execution");
            expect(agent.liveView()).toBeNull();
          },
        },
      ]);
      expect(result.isErr() ? result.error : null).toBeNull();
    });
  },
);

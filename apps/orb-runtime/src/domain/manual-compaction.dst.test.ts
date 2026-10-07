import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SimulationTask } from "determined";
import { okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { PiOrbAgent, type PiSession } from "../pi/agent.ts";
import { MemoryIdleStopFence } from "../testkit/idle-stop-fence.ts";
import { runDst } from "../testkit/sim.ts";

it("races compact and idle-stop through production synchronous ownership", async () => {
  await runDst({ name: "compact-versus-stop", iterations: 40 }, async (sim) => {
    const agent = new PiOrbAgent({
      orbId: "compact-race",
      repositoryUrl: "https://example.com/repo",
      workDir: "/test",
      skillsDir: null,
      broker: null,
      executionId: "execution",
      idleStopFence: new MemoryIdleStopFence(),
    });
    let compactTask: SimulationTask | undefined;
    let runs = 0;
    const session = {
      isIdle: true,
      pendingMessageCount: 0,
      subscribe: () => () => undefined,
      compact: async () => {
        runs++;
        await compactTask?.checkpoint("native compact owns admission");
        expect(agent.gateView().acceptingWork).toBe(true);
        expect(agent.gateView().activity).toBe("busy");
        return {};
      },
      waitForIdle: async () => {
        await compactTask?.checkpoint("native compact drain before publication");
      },
      abortCompaction: () => {},
      abort: async () => {},
    } as unknown as PiSession;
    agent.attachSession(session, SessionManager.inMemory("/test"), {
      summarize: () => okAsync(""),
    });
    const result = await sim.runTasks([
      {
        name: "compact-request",
        f: async (task) => {
          compactTask = task;
          await task.checkpoint("before compaction admission");
          const completion = await agent.compact(undefined, "operation");
          if (completion.isErr()) {
            expect(runs).toBe(0);
            expect(agent.gateView().acceptingWork).toBe(false);
          } else expect(runs).toBe(1);
        },
      },
      {
        name: "idle-stop",
        f: async (task) => {
          await task.checkpoint("before idle-stop admission");
          const busy = agent.gateView().activity === "busy";
          expect(agent.prepareIdleStop()._unsafeUnwrap()).toBe(!busy);
          if (busy) expect(agent.gateView().acceptingWork).toBe(true);
        },
      },
    ]);
    expect(result.isErr() ? result.error : null).toBeNull();
    expect(agent.gateView().activity).toBe("idle");
  });
});

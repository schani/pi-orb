import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ok, okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { PiOrbAgent, type PiSession } from "../pi/agent.ts";
import { ComposedClaudeFixture } from "../testkit/claude-composed.ts";
import { MemoryIdleStopFence } from "../testkit/idle-stop-fence.ts";
import { runDst } from "../testkit/sim.ts";
import { RuntimePreviewService } from "./preview.ts";

it.each([false, true])(
  "Pi preview and persisted idle fence exclude each other (stop first=%s)",
  async (stopFirst) => {
    await runDst({ name: `preview-pi-fence-${stopFirst}`, iterations: 30 }, async (sim) => {
      const result = await sim.runTasks([
        {
          name: "runtime",
          f: async (task) => {
            const fence = new MemoryIdleStopFence();
            let duringPersist = false;
            const agent = new PiOrbAgent({
              orbId: "orb",
              repositoryUrl: "https://example.com/repo",
              workDir: "/test",
              skillsDir: null,
              broker: null,
              executionId: "execution",
              idleStopFence: {
                read: () => fence.read(),
                write: (id) => {
                  // Reentrant admission while persistence is deliberately held must already be fenced.
                  duringPersist = service.admit("grant", 3000, "http").isErr();
                  return fence.write(id);
                },
              },
            });
            agent.attachSession(
              { isIdle: true, subscribe: () => () => undefined } as unknown as PiSession,
              SessionManager.inMemory("/test"),
              { summarize: () => okAsync("") },
            );
            const service = new RuntimePreviewService({
              agent,
              orbId: "orb",
              reservedPorts: () => [8080],
              verifier: {
                verify: () =>
                  ok({
                    v: 1,
                    origin: "https://preview.example",
                    expiresAt: 10000,
                    target: {
                      orbId: "orb",
                      port: 3000,
                      registrationId: "generation",
                      executionId: "execution",
                      incarnation: 0,
                      runtimeInstanceId: agent.runtimeInstanceId,
                    },
                  }),
              },
            });
            await task.checkpoint("preview.before-claim");
            if (stopFirst) {
              expect(agent.prepareIdleStop()._unsafeUnwrap()).toBe(true);
              expect(duringPersist).toBe(true);
              expect(service.admit("grant", 3000, "http").isErr()).toBe(true);
            } else {
              const lease = service.admit("grant", 3000, "http")._unsafeUnwrap();
              await task.checkpoint("preview.http-active-before-idle");
              expect(agent.prepareIdleStop()._unsafeUnwrap()).toBe(false);
              expect(fence.read()._unsafeUnwrap()).toBeNull();
              expect(agent.getHealth()).toMatchObject({ activity: "idle" });
              lease.release();
            }
          },
        },
      ]);
      expect(result.isErr() ? result.error : null).toBeNull();
    });
  },
);

it("Claude rejects idle preparation for active HTTP without reporting agent busy", async () => {
  const fixture = new ComposedClaudeFixture();
  try {
    expect((await fixture.attach()).isOk()).toBe(true);
    const lease = fixture.agent.previewActivity.acquire("http");
    expect(fixture.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
    expect(fixture.agent.prepareIdleStop()._unsafeUnwrap()).toBe(false);
    lease.release();
    fixture.agent.shutdownHooks();
    expect(fixture.agent.gateView().acceptingWork).toBe(false);
  } finally {
    await fixture.agent.closeExtensions();
    fixture.dispose();
  }
});

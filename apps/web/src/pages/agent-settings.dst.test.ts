import type { AgentSettings, ServerFrame } from "@pi-orb/protocol";
import { initialState, reducer } from "@pi-orb/transcript";
import { ok, okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { AgentSettingsController } from "../../../orb-runtime/src/domain/agent-settings.ts";
import { OutboundWriter } from "../../../orb-runtime/src/domain/outbound.ts";
import { decideRequest, RequestRegistry } from "../../../orb-runtime/src/domain/requests.ts";
import { computeSyncFrames } from "../../../orb-runtime/src/domain/sync.ts";
import {
  PiOrbAgent,
  type PiSession,
  type PiSessionManager,
} from "../../../orb-runtime/src/pi/agent.ts";
import { runDst } from "../../../orb-runtime/src/testkit/sim.ts";

it.each([false, true])(
  "composed settings DST: real agent admission, registry, sync/writer and browser (backpressure=%s)",
  async (queued) => {
    await runDst({ name: `settings-composed-${queued}`, iterations: 20 }, async (sim) => {
      const result = await sim.runTasks([
        {
          name: "runtime",
          f: async (task) => {
            const agent = new PiOrbAgent({
              skillsDir: null,
              orbId: "test",
              repositoryUrl: "https://example.com/repo",
              workDir: "/nonexistent",
              broker: null,
            });
            let browser = initialState();
            let buffered = queued ? 100 : 0;
            const writer = new OutboundWriter(
              {
                get bufferedAmount() {
                  return buffered;
                },
                send: (json) => {
                  browser = reducer(browser, {
                    type: "frame",
                    frame: JSON.parse(json) as ServerFrame,
                  });
                },
                close: () => expect.fail("unexpected close"),
              },
              { highWaterMark: 1, maxCriticalBufferedBytes: 100000 },
            );
            const initial: AgentSettings = {
              model: { provider: "test", id: "a" },
              thinkingLevel: "high",
            };
            let disk = initial,
              writes = 0,
              deliveries = 0;
            const registry = new RequestRegistry();
            const action = { type: "set_thinking", thinkingLevel: "low" } as const;
            const controller = new AgentSettingsController({
              task,
              initial,
              models: [{ ...initial.model, name: "A", thinkingLevels: ["low", "high"] }],
              isIdle: () => agent.gateView().activity === "idle",
              publish: (event) => writer.enqueue({ v: 1, type: "runtime.event", at: "now", event }),
              apply: async () => {
                await task.checkpoint("auth yielded with configuration owned");
                expect(
                  decideRequest(agent.gateView(), {
                    type: "shell",
                    expectedHeadId: null,
                    command: "echo no",
                    excludeFromContext: false,
                  }),
                ).toMatchObject({ type: "reject", code: "busy" });
                expect(
                  (
                    await agent.deliverInboxMessage(
                      "inbox",
                      ["inbox"],
                      [{ type: "text", text: "do not deliver yet" }],
                    )
                  ).isErr(),
                ).toBe(true);
                expect(deliveries).toBe(0);
                const snapshot = agent.snapshot();
                expect(snapshot.isOk()).toBe(true);
                if (snapshot.isOk()) {
                  const reconnect = computeSyncFrames(snapshot.value, null, null, "now");
                  expect(reconnect).toContainEqual({
                    v: 1,
                    type: "runtime.event",
                    at: "now",
                    event: { ...controller.view, settings: initial, writable: false },
                  });
                }
                expect(registry.lookup("request", action).type).toBe("pending");
                disk = { ...initial, thinkingLevel: "low" };
                writes++;
                await task.checkpoint("persisted but receipt lost");
                return ok(disk);
              },
            });
            const manager = {
              getEntries: () => [],
              getLeafId: () => null,
              getHeader: () => ({ id: "session" }),
              getSessionId: () => "session",
              getSessionFile: () => undefined,
              buildContextEntries: () => [],
              appendCustomEntry: () => "baseline",
            } as unknown as PiSessionManager;
            const session = {
              subscribe: () => () => {},
              sendCustomMessage: async () => {
                deliveries++;
              },
            } as unknown as PiSession;
            agent.attachSession(session, manager, { summarize: () => okAsync("") }, controller);
            registry.reserve("request", action);
            expect((await agent.changeSettings(action)).isOk()).toBe(true);
            registry.record("request", action, { type: "settings_applied", duplicate: false });
            buffered = 0;
            writer.onDrain();
            expect(browser.settings?.settings).toEqual(disk);
            expect(writes).toBe(1);
            const replay = registry.lookup("request", action);
            expect(replay).toEqual({
              type: "replay",
              result: { type: "settings_applied", duplicate: true },
            });
            writer.enqueue({
              v: 1,
              type: "request.result",
              at: "now",
              requestId: "request",
              result: { type: "settings_applied", duplicate: true },
            });
            expect(browser.settings?.settings).toEqual(disk);
            expect(agent.gateView().configuring).toBe(false);
            expect(new RequestRegistry().lookup("request", action).type).toBe("new");
          },
        },
      ]);
      if (result.isErr()) throw result.error;
    });
  },
);

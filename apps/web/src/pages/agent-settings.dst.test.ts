import type { ServerFrame } from "@pi-orb/protocol";
import { expect, it } from "vitest";
import type { ClaudeQuery } from "../../../orb-runtime/src/claude/agent.ts";
import { OutboundWriter } from "../../../orb-runtime/src/domain/outbound.ts";
import { decideRequest, RequestRegistry } from "../../../orb-runtime/src/domain/requests.ts";
import { computeSyncFrames } from "../../../orb-runtime/src/domain/sync.ts";
import { ComposedClaudeFixture } from "../../../orb-runtime/src/testkit/claude-composed.ts";
import { runDst } from "../../../orb-runtime/src/testkit/sim.ts";
import { initialState, reducer } from "./OrbPage.tsx";

it.each([false, true])(
  "composed Claude settings DST: admission, registry, sync/writer and browser (backpressure=%s)",
  async (queued) => {
    await runDst({ name: `claude-settings-composed-${queued}`, iterations: 20 }, async (sim) => {
      let releaseAccount: () => void = () => undefined;
      const accountReady = new Promise<void>((resolve) => {
        releaseAccount = resolve;
      });
      const f = new ComposedClaudeFixture(accountReady);
      try {
        const metadata = f.nextQuery();
        const attaching = f.attach();
        const query: ClaudeQuery = await metadata;
        query.supportedModels = async () => [
          {
            value: "opus",
            displayName: "Opus",
            description: "",
            supportedEffortLevels: ["low", "high"],
          },
        ];
        expect((await attaching).isOk()).toBe(true);
        const initial = f.agent.snapshot()._unsafeUnwrap().settings;
        expect(initial?.settings.thinkingLevel).toBe("high");
        const result = await sim.runTasks([
          {
            name: "runtime",
            f: async (task) => {
              let browser = initialState("orb-a");
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
              f.agent.subscribe((frame) => writer.enqueue(frame));
              const registry = new RequestRegistry();
              const action = { type: "set_thinking", thinkingLevel: "low" } as const;
              registry.reserve("request", action);
              const next = f.nextQuery();
              const changing = f.agent.changeSettings(action);
              const settingsQuery = await next;
              const settingsSDK: ClaudeQuery = settingsQuery;
              settingsSDK.supportedModels = query.supportedModels;
              let mutations = 0;
              settingsSDK.applyFlagSettings = async (flags) => {
                if (flags.effortLevel !== "low") return;
                await task.checkpoint("native settings yielded with configuration owned");
                expect(
                  decideRequest(f.agent.gateView(), {
                    type: "message",
                    expectedHeadId: null,
                    content: [{ type: "text", text: "do not submit yet" }],
                  }),
                ).toMatchObject({ type: "reject", code: "busy" });
                expect(
                  (
                    await f.agent.deliverInboxMessage(
                      "inbox",
                      ["inbox"],
                      [{ type: "text", text: "do not deliver yet" }],
                    )
                  ).isErr(),
                ).toBe(true);
                const reconnect = computeSyncFrames(
                  f.agent.snapshot()._unsafeUnwrap(),
                  null,
                  null,
                  "now",
                );
                expect(reconnect).toContainEqual({
                  v: 1,
                  type: "runtime.event",
                  at: "now",
                  event: { ...initial, writable: false },
                });
                expect(registry.lookup("request", action).type).toBe("pending");
                mutations++;
                settingsQuery.exit();
                settingsQuery.endOutput();
              };
              releaseAccount();
              expect((await changing).isOk()).toBe(true);
              expect(f.journal().effort).toBe("low");
              await task.checkpoint("persisted but receipt lost");
              registry.record("request", action, { type: "settings_applied", duplicate: false });
              buffered = 0;
              writer.onDrain();
              expect(browser.settings).toMatchObject({
                settings: { model: { provider: "claude", id: "opus" }, thinkingLevel: "low" },
                writable: true,
              });
              expect(mutations).toBe(1);
              expect(registry.lookup("request", action)).toEqual({
                type: "replay",
                result: { type: "settings_applied", duplicate: true },
              });
              const applied = browser.settings;
              writer.enqueue({
                v: 1,
                type: "request.result",
                at: "now",
                requestId: "request",
                result: { type: "settings_applied", duplicate: true },
              });
              expect(browser.settings).toEqual(applied);
              expect(f.agent.gateView().configuring).toBe(false);
              expect(new RequestRegistry().lookup("request", action).type).toBe("new");
            },
          },
        ]);
        if (result.isErr()) throw result.error;
      } finally {
        f.query.exit();
        f.query.endOutput();
        await f.agent.closeExtensions();
        f.dispose();
      }
    });
  },
);

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ServerFrame } from "@pi-orb/protocol";
import { expect, it } from "vitest";
import { OutboundWriter } from "../../../orb-runtime/src/domain/outbound.ts";
import {
  ComposedClaudeFixture,
  rootRequest,
} from "../../../orb-runtime/src/testkit/claude-composed.ts";
import { initialState, reducer } from "./OrbPage.tsx";

it.each(["bash", "codemode"])("retains %s code through live tool states", (name) => {
  let state = initialState("test");
  for (const phase of ["running", "completed"] as const) {
    state = reducer(state, {
      type: "frame",
      frame: {
        v: 1,
        type: "runtime.event",
        at: "now",
        event: {
          type: "tool_state",
          operationId: "op",
          callId: "call",
          name,
          state: phase,
          revision: 1,
          code: "raw source",
        },
      },
    });
    expect(state.tools.get("call")).toMatchObject({ code: "raw source", state: phase });
  }
});

it("reduces live headline replacements independently of hidden reasoning text", () => {
  let state = initialState("test");
  for (const headline of ["Inspect", "Inspect · Fix", ""]) {
    state = reducer(state, {
      type: "frame",
      frame: {
        v: 1,
        type: "runtime.event",
        at: "now",
        event: {
          type: "output_patch",
          operationId: "op",
          blockId: "b",
          blockType: "reasoning",

          revision: 1,
          headline,
          patch: { type: "replace", text: "" },
        },
      },
    });
    expect(state.liveBlocks.get("b")).toMatchObject({ headline, text: "" });
  }
});

// Exhaust immediate/backpressured delivery, next-response timing, snapshot/SDK
// publication, and a failed journal commit before the response becomes durable.
it.each(
  [false, true].flatMap((queued) =>
    [false, true].flatMap((nextBeforeRetirement) =>
      [false, true].flatMap((publishViaSnapshot) =>
        [false, true].map((blockedFirst) => ({
          queued,
          nextBeforeRetirement,
          publishViaSnapshot,
          blockedFirst,
        })),
      ),
    ),
  ),
)(
  "retires previous Claude response output: %j",
  async ({ queued, nextBeforeRetirement, publishViaSnapshot, blockedFirst }) => {
    const f = new ComposedClaudeFixture();
    try {
      expect((await f.attach()).isOk()).toBe(true);
      let browser = initialState("orb-a");
      let firstIds: string[] = [];
      const committedSnapshots: { browser: string[]; reconnect: string[] }[] = [];
      const frames: ServerFrame[] = [];
      let bufferedAmount = queued ? 100 : 0;
      const writer = new OutboundWriter(
        {
          get bufferedAmount() {
            return bufferedAmount;
          },
          send(json) {
            const frame = JSON.parse(json) as ServerFrame;
            frames.push(frame);
            browser = reducer(browser, { type: "frame", frame });
            // Each delivered frame is a possible render and reconnect boundary.
            if (browser.records.has("saved")) {
              committedSnapshots.push({
                browser: [...browser.liveBlocks.keys()].filter((id) => firstIds.includes(id)),
                reconnect: (f.agent.liveView()?.blocks ?? [])
                  .map((block) => block.blockId)
                  .filter((id) => firstIds.includes(id)),
              });
            }
          },
          close() {
            expect.fail("unexpected backpressure close");
          },
        },
        { highWaterMark: 1, maxCriticalBufferedBytes: 100_000 },
      );
      f.agent.subscribe((frame) => writer.enqueue(frame));
      expect((await f.agent.submitMessage([{ type: "text", text: "hello" }], "op")).isOk()).toBe(
        true,
      );
      const input = await f.query.input.next();
      if (input.done) throw new Error("missing native input");
      f.receipt(input.value);
      const send = (message: object) => f.query.emitUnscheduled(message as SDKMessage);
      const stream = (uuid: string, index: number, thinking: string) =>
        send({
          type: "stream_event",
          uuid,
          session_id: f.state.id,
          parent_tool_use_id: null,
          event: {
            type: "content_block_start",
            index,
            content_block: { type: "thinking", thinking },
          },
        });
      for (const [index, thinking] of ["first", "stale tail", "another stale tail"].entries())
        await stream("first-stream", index, thinking);
      firstIds = f.agent.liveView()?.blocks.map((block) => block.blockId) ?? [];
      expect(firstIds).toHaveLength(3);
      const finalMessage = {
        type: "assistant",
        uuid: "saved",
        timestamp: f.state.timestamp,
        session_id: f.state.id,
        parent_tool_use_id: null,
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "final normalized reasoning" }],
        },
      };
      // UUID ownership, not text equality, must retire all streamed blocks.
      await send(finalMessage);
      const next = () => stream("next-stream", 0, "second");
      if (nextBeforeRetirement) await next();
      f.append(finalMessage);
      if (blockedFirst) {
        f.failCommit = true;
        expect(f.agent.snapshot().isErr()).toBe(true);
        expect(
          f.agent.liveView()?.blocks.filter((block) => firstIds.includes(block.blockId)),
        ).toHaveLength(3);
        expect(
          frames.some((frame) => frame.type === "history.record" && frame.record.id === "saved"),
        ).toBe(false);
        f.failCommit = false;
      }
      if (publishViaSnapshot) expect(f.agent.snapshot().isOk()).toBe(true);
      else await send(rootRequest);
      expect(
        f.agent.liveView()?.blocks.filter((block) => firstIds.includes(block.blockId)),
      ).toEqual([]);
      if (!nextBeforeRetirement) {
        expect(f.agent.liveView()?.blocks).toEqual([]);
        await next();
      }
      bufferedAmount = 0;
      writer.onDrain();
      expect(f.agent.liveView()?.blocks.map((block) => block.text)).toEqual(["second"]);
      expect([...browser.liveBlocks.values()].map((block) => block.text)).toEqual([""]);
      expect(firstIds).not.toContain([...browser.liveBlocks.keys()][0]);
      const saved = frames.find(
        (frame) => frame.type === "history.record" && frame.record.id === "saved",
      );
      expect(saved).toMatchObject({ retiredBlockIds: firstIds });
      expect(committedSnapshots.length).toBeGreaterThan(0);
      for (const snapshot of committedSnapshots)
        expect(snapshot).toEqual({ browser: [], reconnect: [] });
      expect(
        frames.some(
          (frame) =>
            frame.type === "runtime.event" && String(frame.event.type) === "output_retired",
        ),
      ).toBe(false);
    } finally {
      f.failCommit = false;
      f.query.exit();
      f.query.endOutput();
      await f.agent.closeExtensions();
      f.dispose();
    }
  },
);

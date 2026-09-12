import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ServerFrame } from "@pi-orb/protocol";
import { okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { OutboundWriter } from "../../../orb-runtime/src/domain/outbound.ts";
import {
  PiOrbAgent,
  type PiSession,
  type PiSessionManager,
} from "../../../orb-runtime/src/pi/agent.ts";
import { initialState, reducer } from "./OrbPage.tsx";

// Exhaust the finite schedules: next response before/after publication,
// immediate/backpressured delivery, snapshot/microtask flush, and a mapping
// failpoint before the committed response. Inspect every delivered frame.
it.each(
  [false, true].flatMap((queued) =>
    [false, true].flatMap((nextBeforeRetirement) =>
      [false, true].flatMap((snapshotBeforeFlush) =>
        [false, true].map((blockedFirst) => ({
          queued,
          nextBeforeRetirement,
          snapshotBeforeFlush,
          blockedFirst,
        })),
      ),
    ),
  ),
)(
  "retires previous response output: %j",
  async ({ queued, nextBeforeRetirement, snapshotBeforeFlush, blockedFirst }) => {
    let emit: (event: AgentSessionEvent) => void = () => undefined;
    const summarizer = { summarize: () => okAsync("") };
    const agent = new PiOrbAgent({
      skillsDir: null,
      orbId: "test",
      repositoryUrl: "https://example.com/repo",
      workDir: "/nonexistent",
      broker: null,
      turnSummarizer: summarizer,
    });
    const session = {
      subscribe: (listener: typeof emit) => {
        emit = listener;
        return () => undefined;
      },
    } as unknown as PiSession;
    const entries: unknown[] = [];
    const manager = {
      getEntries: () => entries,
      getLeafId: () => null,
      getHeader: () => ({ id: "session" }),
      getSessionId: () => "session",
      getSessionFile: () => undefined,
      buildContextEntries: () => entries,
      appendCustomEntry: () => "baseline",
    } as unknown as PiSessionManager;
    agent.attachSession(session, manager, summarizer);
    let browser = initialState("test");
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
          // Each frame is a possible React render and reconnect boundary.
          if (browser.records.has("saved")) {
            committedSnapshots.push({
              browser: [...browser.liveBlocks.keys()].filter((id) => firstIds.includes(id)),
              reconnect: (agent.liveView()?.blocks ?? [])
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
    agent.subscribe((frame) => writer.enqueue(frame));
    const send = (event: unknown) => emit(event as AgentSessionEvent);
    const response = (texts: string[]) => ({
      role: "assistant",
      content: texts.map((thinking) => ({ type: "thinking", thinking })),
      stopReason: "toolUse",
    });
    const next = () => {
      send({ type: "message_start", message: response([]) });
      send({ type: "message_update", message: response(["second"]) });
    };
    send({ type: "agent_start" });
    send({ type: "message_start", message: response([]) });
    send({
      type: "message_update",
      message: response(["first", "stale tail", "another stale tail"]),
    });
    firstIds = agent.liveView()?.blocks.map((block) => block.blockId) ?? [];
    expect(firstIds).toHaveLength(3);
    const finalMessage = response(["final normalized reasoning"]);
    send({ type: "message_end", message: finalMessage });
    // The SDK persists after invoking its subscribers. Deliberately use final
    // text different from the stream, defeating the old text-equality heuristic.
    if (blockedFirst) entries.push({ id: "bad", type: "unmappable" });
    entries.push({
      id: "saved",
      parentId: null,
      type: "message",
      timestamp: "2026-09-09T00:00:00Z",
      message: finalMessage,
    });
    if (nextBeforeRetirement) next();
    if (blockedFirst) {
      expect(agent.snapshot().isErr()).toBe(true);
      expect(
        agent.liveView()?.blocks.filter((block) => firstIds.includes(block.blockId)),
      ).toHaveLength(3);
      expect(frames.some((frame) => frame.type === "history.record")).toBe(false);
      entries.shift(); // Release only the explicit mapping failpoint.
    }
    // Force a reconnect snapshot in the notify/append/microtask gap too.
    if (snapshotBeforeFlush) {
      const reconnect = agent.snapshot();
      expect(reconnect.isErr() ? reconnect.error : null).toBeNull();
      expect(agent.liveView()?.blocks.filter((block) => firstIds.includes(block.blockId))).toEqual(
        [],
      );
    }
    await Promise.resolve();
    if (!nextBeforeRetirement) {
      expect(agent.liveView()?.blocks).toEqual([]);
      next();
    }
    bufferedAmount = 0;
    writer.onDrain();
    expect(agent.liveView()?.blocks.map((block) => block.text)).toEqual(["second"]);
    expect([...browser.liveBlocks.values()].map((block) => block.text)).toEqual(["second"]);
    expect(firstIds).not.toContain([...browser.liveBlocks.keys()][0]);
    const saved = frames.findIndex((frame) => frame.type === "history.record");
    expect(saved).toBeGreaterThanOrEqual(0);
    expect(committedSnapshots.length).toBeGreaterThan(0);
    for (const snapshot of committedSnapshots)
      expect(snapshot).toEqual({ browser: [], reconnect: [] });
    expect(frames[saved]).toMatchObject({ retiredBlockIds: firstIds });
    expect(
      frames.some(
        (frame) => frame.type === "runtime.event" && String(frame.event.type) === "output_retired",
      ),
    ).toBe(false);
  },
);

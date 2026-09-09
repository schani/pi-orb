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

// Exhaust the two scheduling boundaries explicitly: persistence retirement
// before/after the next response starts, and immediate/backpressured delivery.
it.each([
  { queued: false, nextBeforeRetirement: false },
  { queued: false, nextBeforeRetirement: true },
  { queued: true, nextBeforeRetirement: false },
  { queued: true, nextBeforeRetirement: true },
])("retires previous response output: %j", async ({ queued, nextBeforeRetirement }) => {
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
  } as unknown as PiSessionManager;
  agent.attachSession(session, manager, summarizer);
  let browser = initialState("test");
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
  const firstIds = agent.liveView()?.blocks.map((block) => block.blockId) ?? [];
  expect(firstIds).toHaveLength(3);
  send({ type: "message_end", message: response(["first", "stale tail", "another stale tail"]) });
  // The SDK persists after invoking its subscribers. Deliberately use final
  // text different from the stream, defeating the old text-equality heuristic.
  entries.push({
    id: "saved",
    parentId: null,
    type: "message",
    timestamp: "2026-09-09T00:00:00Z",
    message: response(["final normalized reasoning"]),
  });
  if (nextBeforeRetirement) next();
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
  const retired = frames.findIndex(
    (frame) => frame.type === "runtime.event" && frame.event.type === "output_retired",
  );
  expect(saved).toBeGreaterThanOrEqual(0);
  expect(retired).toBeGreaterThan(saved);
});

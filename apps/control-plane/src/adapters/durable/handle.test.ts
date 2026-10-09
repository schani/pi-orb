import type { ServerFrame } from "@pi-orb/protocol";
import { err, okAsync } from "neverthrow";
import { expect, it } from "vitest";
import type { AgentSessionFacade } from "../../domain/agent-ports.ts";
import { StableAgentHandle } from "./handle.ts";

function facade(id: string) {
  let callback: (frame: ServerFrame) => void = () => undefined;
  let invalidated: () => void = () => undefined;
  const session: AgentSessionFacade = {
    runtimeInstanceId: id,
    snapshot: () => err({ message: "not loaded" }),
    liveView: () => null,
    subscribe: (listener, onInvalidated) => {
      callback = listener;
      invalidated = onInvalidated ?? invalidated;
      return () => {
        callback = () => undefined;
      };
    },
    request: () => okAsync({ type: "accepted", operationId: "operation", duplicate: false }),
  };
  return {
    session,
    emit: (frame: ServerFrame) => callback(frame),
    invalidate: () => invalidated(),
  };
}

it("keeps subscription identity across heavy-owner replacement and ignores late frames", () => {
  const a = facade("a"),
    b = facade("b");
  const handle = new StableAgentHandle("orb", () => okAsync(b.session));
  const frames: unknown[] = [];
  let closed = false;
  handle.subscribe(
    (frame) => frames.push(frame),
    () => {
      closed = true;
    },
  );
  handle.attach(a.session);
  const frameA: ServerFrame = {
    v: 1,
    type: "runtime.event",
    at: "now",
    event: { type: "status", activity: "busy" },
  };
  const frameB: ServerFrame = {
    v: 1,
    type: "runtime.event",
    at: "now",
    event: { type: "status", activity: "idle" },
  };
  a.emit(frameA);
  a.invalidate();
  handle.attach(b.session);
  a.emit(frameA);
  b.emit(frameB);
  expect(frames).toEqual([frameA, frameB]);
  expect(closed).toBe(false);
  handle.dispose();
  expect(closed).toBe(true);
});

it("does not instantiate heavy state for snapshot/history inspection", () => {
  let opens = 0;
  const handle = new StableAgentHandle("orb", () => {
    opens++;
    return okAsync(facade("new").session);
  });
  expect(handle.snapshot()).toEqual(err({ message: "conversation snapshot unavailable" }));
  expect(handle.liveView()).toBeNull();
  expect(handle.workActive()).toBe(false);
  expect(opens).toBe(0);
});

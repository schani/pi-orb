import { expect, it } from "vitest";
import { readonlySubscription } from "./durable-subscription.ts";

it("uses current readonly state on the original welcomed subscription without a new frame", () => {
  const frame = (payload: string, socketGeneration = 2) => ({
    direction: "received" as const,
    payload,
    socketGeneration,
  });
  const frames = [
    frame(JSON.stringify({ type: "server.welcome" })),
    frame(
      JSON.stringify({ type: "runtime.event", event: { type: "agent_settings", writable: false } }),
    ),
  ];
  expect(readonlySubscription(frames, 2)).toBe(2);
  expect(readonlySubscription(frames, 3)).toBeNull();
  frames.push(
    frame(
      JSON.stringify({ type: "runtime.event", event: { type: "agent_settings", writable: true } }),
    ),
  );
  expect(readonlySubscription(frames, 2)).toBeNull();
  frames.push(
    frame(
      JSON.stringify({ type: "runtime.event", event: { type: "agent_settings", writable: false } }),
    ),
  );
  expect(readonlySubscription(frames, 2)).toBe(2);
  expect(readonlySubscription(frames.slice(1), 2)).toBeNull();
});

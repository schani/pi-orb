import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import { expect, it } from "vitest";

const message = (text: string): AgentMessage => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: 0,
});

it("selective cancellation preserves unrelated steering/follow-up order", () => {
  const agent = new Agent({
    streamFn: () => {
      throw new Error("No inference expected");
    },
    steeringMode: "all",
    followUpMode: "all",
  });
  const before = message("extension-before");
  const owned = message("inbox");
  const after = message("extension-after");
  const followUp = message("follow-up");
  agent.steer(before);
  agent.steer(owned);
  agent.steer(after);
  agent.followUp(followUp);
  expect(agent.cancelQueuedSteeringMessage((entry) => entry === owned)).toBe(true);
  expect(agent.peekQueuedMessages()).toEqual([before, after]);
  agent.clearSteeringQueue();
  expect(agent.peekQueuedMessages()).toEqual([followUp]);
});

it("missing or ambiguous queue ownership cannot remove anything", () => {
  const agent = new Agent({
    streamFn: () => {
      throw new Error("No inference expected");
    },
    steeringMode: "all",
  });
  const owned = message("inbox");
  agent.steer(owned);
  agent.steer(owned);
  expect(agent.cancelQueuedSteeringMessage((entry) => entry === owned)).toBe(false);
  expect(agent.cancelQueuedSteeringMessage(() => false)).toBe(false);
  expect(agent.peekQueuedMessages()).toEqual([owned, owned]);
});

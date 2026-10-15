import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ServerFrame } from "@pi-orb/protocol";
import * as protocol from "@pi-orb/protocol";
import { expect, it, vi } from "vitest";
import { ClaudeOrbAgent } from "./agent.ts";

it("Claude text starts replace and deltas append without parsing reasoning or adding its metadata", () => {
  const headline = vi.spyOn(protocol, "reasoningHeadline");
  try {
    const agent = new ClaudeOrbAgent({
      orbId: "orb",
      repositoryUrl: "https://example.com/repo",
      workDir: "/unused",
      skillsDir: null,
      broker: null,
    });
    agent["activity"].claim("operation");
    const frames: ServerFrame[] = [];
    agent.subscribe((frame) => frames.push(frame));
    const send = (event: unknown) =>
      agent["onMessage"]({
        type: "stream_event",
        uuid: "00000000-0000-0000-0000-000000000000",
        session_id: "session",
        parent_tool_use_id: null,
        event,
      } as SDKMessage);
    send({
      type: "content_block_start",
      index: 4,
      content_block: { type: "text", text: "# Initial prose" },
    });
    send({
      type: "content_block_delta",
      index: 4,
      delta: { type: "text_delta", text: "\n\nMore prose" },
    });
    const patches = frames.flatMap((frame) =>
      frame.type === "runtime.event" && frame.event.type === "output_patch" ? [frame.event] : [],
    );
    expect(patches).toEqual([
      {
        type: "output_patch",
        operationId: "operation",
        blockId: "00000000-0000-0000-0000-000000000000:4",
        blockType: "text",
        revision: 0,
        patch: { type: "replace", text: "# Initial prose" },
      },
      {
        type: "output_patch",
        operationId: "operation",
        blockId: "00000000-0000-0000-0000-000000000000:4",
        blockType: "text",
        revision: 1,
        patch: { type: "append", text: "\n\nMore prose" },
      },
    ]);
    expect(agent.liveView()?.blocks[0]).toMatchObject({
      contentIndex: 4,
      text: "# Initial prose\n\nMore prose",
    });
    expect(headline).not.toHaveBeenCalled();
  } finally {
    headline.mockRestore();
  }
});

it("Claude suppresses empty thinking and publishes content-free initial, headingless and redacted thinking", () => {
  const agent = new ClaudeOrbAgent({
    orbId: "orb",
    repositoryUrl: "https://example.com/repo",
    workDir: "/unused",
    skillsDir: null,
    broker: null,
  });
  agent["activity"].claim("operation");
  const frames: ServerFrame[] = [];
  agent.subscribe((frame) => frames.push(frame));
  const send = (event: unknown) =>
    agent["onMessage"]({
      type: "stream_event",
      uuid: "00000000-0000-0000-0000-000000000000",
      session_id: "session",
      parent_tool_use_id: null,
      event,
    } as SDKMessage);
  send({
    type: "content_block_start",
    index: 0,
    content_block: { type: "thinking", thinking: "", signature: "ENCRYPTED_CANARY" },
  });
  send({
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: " \n" },
  });
  send({
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: "PRIVATE_HEADINGLESS" },
  });
  send({
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: " grows" },
  });
  send({
    type: "content_block_start",
    index: 2,
    content_block: { type: "thinking", thinking: "# Initial\n\nPRIVATE_INITIAL", signature: "" },
  });
  send({
    type: "content_block_start",
    index: 3,
    content_block: { type: "redacted_thinking", data: "ENCRYPTED_REDACTED" },
  });
  send({
    type: "content_block_delta",
    index: 2,
    delta: { type: "thinking_delta", thinking: " body grows" },
  });
  send({
    type: "content_block_delta",
    index: 2,
    delta: { type: "thinking_delta", thinking: "\n\n# Verify\n\nPRIVATE_VERIFY" },
  });
  const patches = frames.flatMap((frame) =>
    frame.type === "runtime.event" && frame.event.type === "output_patch" ? [frame.event] : [],
  );
  expect(patches).toMatchObject([
    { blockId: "00000000-0000-0000-0000-000000000000:0", headline: "" },
    { blockId: "00000000-0000-0000-0000-000000000000:2", headline: "Initial" },
    { blockId: "00000000-0000-0000-0000-000000000000:3", headline: "" },
    { blockId: "00000000-0000-0000-0000-000000000000:2", headline: "Initial · Verify" },
  ]);
  expect(patches.every((patch) => patch.patch.type === "replace" && patch.patch.text === "")).toBe(
    true,
  );
  expect(JSON.stringify(frames)).not.toMatch(/PRIVATE_|ENCRYPTED_|contentIndex|reasoningVisible/);
  expect(agent.liveView()?.blocks).toMatchObject([
    { contentIndex: 0, text: " \nPRIVATE_HEADINGLESS grows" },
    {
      contentIndex: 2,
      text: "# Initial\n\nPRIVATE_INITIAL body grows\n\n# Verify\n\nPRIVATE_VERIFY",
    },
    { contentIndex: 3, text: "", redacted: true },
  ]);
});

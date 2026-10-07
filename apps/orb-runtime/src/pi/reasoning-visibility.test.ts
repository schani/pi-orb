import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { OutputPatchEvent, ServerFrame } from "@pi-orb/protocol";
import { okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { computeSyncFrames } from "../domain/sync.ts";
import { MemoryIdleStopFence } from "../testkit/idle-stop-fence.ts";
import { PiOrbAgent, type PiSession } from "./agent.ts";

function fixture() {
  const manager = SessionManager.inMemory("/unused");
  const agent = new PiOrbAgent({
    orbId: "test",
    repositoryUrl: "https://example.com/repo",
    workDir: "/unused",
    skillsDir: null,
    broker: null,
    executionId: "test",
    idleStopFence: new MemoryIdleStopFence(),
  });
  agent.attachSession(
    { isIdle: true, subscribe: () => () => undefined } as unknown as PiSession,
    manager,
    { summarize: () => okAsync("") },
  );
  const frames: ServerFrame[] = [];
  agent.subscribe((frame) => frames.push(frame));
  const send = (event: unknown) =>
    agent["onAgentEvent"](event as Parameters<(typeof agent)["onAgentEvent"]>[0]);
  send({ type: "agent_start" });
  const operationId = agent.liveView()?.operationId ?? "";
  return { agent, manager, frames, send, operationId };
}

it("suppresses empty public thinking while preserving private state, replay and exact commit aliases", () => {
  const { agent, manager, frames, send, operationId } = fixture();
  const message = (thinking: string, redacted = false) => ({
    role: "assistant" as const,
    content: [
      { type: "thinking", thinking: "", thinkingSignature: "ENCRYPTED_CANARY" },
      { type: "text", text: "Visible prose" },
      { type: "thinking", thinking, redacted },
    ],
  });
  for (const [thinking, redacted, visible] of [
    [" \n\t ", false, false],
    ["PRIVATE_HEADINGLESS", false, true],
    ["PRIVATE_HEADINGLESS grows", false, true],
    ["", true, true],
  ] as const) {
    send({ type: "message_update", message: message(thinking, redacted) });
    const live = agent.liveView();
    expect(live).not.toBeNull();
    const replay = computeSyncFrames(
      {
        orbId: "test",
        runtimeInstanceId: "runtime",
        activity: "busy",
        session: { id: "session", overflow: {} },
        records: [],
        headId: null,
      },
      live,
      null,
      "now",
    );
    const patches = replay.flatMap((frame) =>
      frame.type === "runtime.event" && frame.event.type === "output_patch" ? [frame.event] : [],
    );
    expect(patches.filter((patch) => patch.blockType === "reasoning")).toEqual(
      visible
        ? [
            {
              type: "output_patch",
              operationId,
              blockId: `${operationId}-0-2`,
              blockType: "reasoning",
              revision: expect.any(Number),
              headline: "",
              patch: { type: "replace", text: "" },
            },
          ]
        : [],
    );
    expect(agent.readLiveDisplayDetail(operationId, `${operationId}-0-2`)).toMatchObject({
      body: { type: "reasoning", text: thinking },
    });
  }
  const patches = frames.flatMap((frame): OutputPatchEvent[] =>
    frame.type === "runtime.event" && frame.event.type === "output_patch" ? [frame.event] : [],
  );
  expect(patches.filter((patch) => patch.blockId.endsWith("-2"))).toMatchObject([
    { headline: "", patch: { type: "replace", text: "" } },
  ]);
  expect(JSON.stringify(frames)).not.toMatch(
    /PRIVATE_HEADINGLESS|ENCRYPTED_CANARY|reasoningVisible|contentIndex/,
  );
  const final = message("FINAL_PRIVATE");
  const ids = agent.liveView()?.blocks.map((block) => block.blockId);
  send({ type: "message_end", message: final });
  manager.appendMessage(final as Parameters<typeof manager.appendMessage>[0]);
  const snapshot = agent.snapshot();
  expect(snapshot.isOk()).toBe(true);
  if (snapshot.isOk())
    expect(snapshot.value.records.at(-1)).toMatchObject({
      content: [
        { type: "reasoning", text: "" },
        { type: "text" },
        { type: "reasoning", text: "FINAL_PRIVATE" },
      ],
      overflow: { native: { message: final } },
    });
  expect(frames.at(-1)).toMatchObject({
    type: "history.record",
    retiredBlockIds: ids,
    detailAliases: [{ blockId: `${operationId}-0-2`, detailKey: expect.stringMatching(/:2$/) }],
    record: {
      content: [{ type: "text" }, { type: "reasoning", detailKey: expect.stringMatching(/:2$/) }],
    },
  });
  expect(agent.liveView()?.blocks).toEqual([]);
});

it("publishes initial redacted thinking and only subsequent headline changes", () => {
  const { agent, frames, send, operationId } = fixture();
  const message = (thinking: string) => ({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "", redacted: true },
      { type: "thinking", thinking },
    ],
  });
  for (const thinking of [
    "# Plan\n\nPRIVATE_A",
    "# Plan\n\nPRIVATE_A grows",
    "# Verify\n\nPRIVATE_B",
  ])
    send({ type: "message_update", message: message(thinking) });
  const patches = frames.flatMap((frame) =>
    frame.type === "runtime.event" && frame.event.type === "output_patch" ? [frame.event] : [],
  );
  expect(patches.map((patch) => [patch.blockId, patch.headline])).toEqual([
    [`${operationId}-0-0`, ""],
    [`${operationId}-0-1`, "Plan"],
    [`${operationId}-0-1`, "Verify"],
  ]);
  expect(JSON.stringify(patches)).not.toMatch(/PRIVATE_|contentIndex|reasoningVisible/);
  expect(agent.readLiveDisplayDetail(operationId, `${operationId}-0-0`)).toMatchObject({
    body: { type: "reasoning", redacted: true },
  });
});

it.each([null, { type: "text", text: null }])(
  "omits aliases when malformed native content compacts canonical indices: %j",
  (malformed) => {
    const { agent, manager, frames, send, operationId } = fixture();
    const content = [
      null,
      { type: "thinking", thinking: "PRIVATE_FIRST" },
      { type: "thinking", thinking: "PRIVATE_SECOND" },
    ];
    send({ type: "message_update", message: { role: "assistant", content } });
    const final = { role: "assistant", content: [malformed, ...content.slice(1)] };
    send({ type: "message_end", message: final });
    manager.appendMessage(final as Parameters<typeof manager.appendMessage>[0]);
    expect(agent.snapshot().isOk()).toBe(true);
    const frame = frames.at(-1);
    expect(frame).toMatchObject({
      type: "history.record",
      retiredBlockIds: [`${operationId}-0-1`, `${operationId}-0-2`],
      record: {
        content: [
          { type: "reasoning", detailKey: expect.stringMatching(/:0$/) },
          { type: "reasoning", detailKey: expect.stringMatching(/:1$/) },
        ],
      },
    });
    expect(frame).not.toHaveProperty("detailAliases");
    expect(agent.liveView()?.blocks).toEqual([]);
  },
);

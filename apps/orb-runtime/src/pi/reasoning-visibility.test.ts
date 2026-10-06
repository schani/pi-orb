import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { OutputPatchEvent, ServerFrame } from "@pi-orb/protocol";
import { okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { computeSyncFrames } from "../domain/sync.ts";
import { MemoryIdleStopFence } from "../testkit/idle-stop-fence.ts";
import { PiOrbAgent, type PiSession } from "./agent.ts";

it("keeps private thinking while public visibility follows body/redaction, including replay and commit", () => {
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
    ["", false, false],
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
    expect(patches.filter((patch) => patch.blockType === "reasoning")).toMatchObject([
      { contentIndex: 0, reasoningVisible: false, patch: { type: "replace", text: "" } },
      { contentIndex: 2, reasoningVisible: visible, patch: { type: "replace", text: "" } },
    ]);
    expect(agent.readLiveDisplayDetail(operationId, `${operationId}-0-2`)).toMatchObject({
      body: { type: "reasoning", text: thinking },
    });
  }
  const patches = frames.flatMap((frame): OutputPatchEvent[] =>
    frame.type === "runtime.event" && frame.event.type === "output_patch" ? [frame.event] : [],
  );
  expect(patches.filter((patch) => patch.blockId.endsWith("-2"))).toMatchObject([
    { reasoningVisible: false },
    { reasoningVisible: true },
    { reasoningVisible: false },
    { reasoningVisible: true },
  ]);
  expect(JSON.stringify(frames)).not.toMatch(/PRIVATE_HEADINGLESS|ENCRYPTED_CANARY/);
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
    record: {
      content: [{ type: "text" }, { type: "reasoning", detailKey: expect.stringMatching(/:2$/) }],
    },
  });
  expect(agent.liveView()?.blocks).toEqual([]);
});

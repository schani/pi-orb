import { expect, it } from "vitest";
import { probeSteering } from "../../../../scripts/claude-sdk-contract/steering.mjs";
import { memoryHistoryFiles } from "../testkit/claude-composed.ts";
import { ClaudeHistory } from "./history.ts";

const nativeIt = it.skipIf(process.platform !== "linux" || process.arch !== "x64");

nativeIt(
  "pinned native now input reaches Claude while its MCP tool remains blocked",
  async () => {
    const result = await probeSteering("tool");
    const files = memoryHistoryFiles();
    files.commit("root.jsonl", result.root.source);
    const history = new ClaudeHistory(
      "history",
      result.root.sessionId,
      "2026-10-15T00:00:00Z",
      files,
    );
    history
      .correlate(result.root.steerUuid, { messageIds: ["steer"], operationId: "operation" })
      ._unsafeUnwrap();
    history.scan("root.jsonl")._unsafeUnwrap();
    expect(history.view.find((record) => record.id === result.root.steerUuid)).toMatchObject({
      type: "event",
      eventType: "claude.input_receipt",
      inboxMessageIds: ["steer"],
    });
    expect(result.steeredWhileToolBlocked).toBe(true);
    expect(result.toolCompleted).toBe(true);
    expect(result.results.at(-1)).toMatchObject({ answersSteer: true, isError: false });
  },
  30_000,
);

nativeIt(
  "pinned native now input interrupts an in-flight response and runs the steering turn",
  async () => {
    const result = await probeSteering("response");
    expect(result.results).toEqual([
      expect.objectContaining({ answersFirst: true, answersSteer: false, isError: false }),
      expect.objectContaining({ answersSteer: true, isError: false }),
    ]);
  },
  30_000,
);

nativeIt(
  "native interruption after a tool is a success result with no thinking owner",
  async () => {
    const probe = await probeSteering("tool-thinking");
    expect(probe.toolCompleted).toBe(true);
    const starts = probe.events.flatMap((message) =>
      message.type === "stream_event" && message.event.type === "message_start"
        ? [{ id: message.event.message.id, input: message.user_message_uuid }]
        : [],
    );
    expect(starts).toHaveLength(3);
    expect(starts[0]?.input).toEqual(expect.any(String));
    expect(starts[1]?.input).toBeUndefined();
    expect(
      probe.events.some(
        (message) => message.type === "assistant" && message.message.id === starts[0]?.id,
      ),
    ).toBe(true);
    expect(
      probe.events.some(
        (message) => message.type === "assistant" && message.message.id === starts[1]?.id,
      ),
    ).toBe(false);
    const interrupted = probe.events.find((message) => message.type === "result");
    expect(interrupted).toMatchObject({
      subtype: "success",
      is_error: false,
      terminal_reason: "aborted_streaming",
      user_message_uuid: starts[0]?.input,
    });
  },
  30_000,
);

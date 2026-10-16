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

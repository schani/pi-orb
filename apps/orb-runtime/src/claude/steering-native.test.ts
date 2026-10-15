import { join } from "node:path";
import { expect, it } from "vitest";
import { probeSteering } from "../../../../scripts/claude-sdk-contract/steering.mjs";
import { ClaudeHistory } from "./history.ts";

const nativeIt = it.skipIf(process.platform !== "linux" || process.arch !== "x64");

nativeIt(
  "pinned native now input reaches Claude while its MCP tool remains blocked",
  async () => {
    const result = await probeSteering("tool", {
      onRoot: ({ home, rootPath, sessionId, steerUuid }) => {
        const history = new ClaudeHistory(join(home, "history"), sessionId, "2026-10-15T00:00:00Z");
        history
          .correlate(steerUuid, { messageIds: ["steer"], operationId: "operation" })
          ._unsafeUnwrap();
        const records = history.scan(rootPath)._unsafeUnwrap();
        const receipt = history.inputReceipt(steerUuid);
        expect(receipt).toMatchObject({
          type: "event",
          eventType: "claude.input_receipt",
          inboxMessageIds: ["steer"],
        });
        expect(records).toContainEqual(receipt);
      },
    });
    expect(result.nativeReceipt).toBe("queued_command");
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
    expect(result.nativeReceipt).toBe("user");
    expect(result.results).toEqual([
      expect.objectContaining({ answersFirst: true, answersSteer: false, isError: false }),
      expect.objectContaining({ answersSteer: true, isError: false }),
    ]);
  },
  30_000,
);

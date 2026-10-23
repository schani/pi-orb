import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { probePassiveBootContext } from "../../../../scripts/claude-sdk-contract/boot-context.mjs";
import { HOST_RESTART_CONTEXT } from "./boot-policy.ts";

it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "pinned native passive context survives metadata reopen and precedes the next querying input",
  async () => {
    const pinned = JSON.parse(
      readFileSync(
        new URL("../../../../scripts/claude-sdk-contract/native-shapes.json", import.meta.url),
        "utf8",
      ),
    );
    const result = await probePassiveBootContext(HOST_RESTART_CONTEXT);
    expect(result.cliVersion).toBe(pinned.cliVersion);
    expect(result.passiveRequests).toBe(0);
    expect(result.metadataRequests).toBe(0);
    expect(result.humanRequests).toBe(1);
    expect(result.passiveBootEntries).toMatchObject([{ isMeta: true }]);
    expect(result.passiveAssistantEntries).toEqual([]);
    expect(result.afterHumanBootEntries).toHaveLength(1);
    expect(JSON.stringify(result.humanMessages).split(HOST_RESTART_CONTEXT)).toHaveLength(2);
    expect(JSON.stringify(result.humanMessages)).toContain("NEW_HUMAN_CONTRACT_TASK");
    expect(result.fifoRequests).toBe(1);
    const fifoMessages = JSON.stringify(result.fifoMessages);
    expect(fifoMessages.split(HOST_RESTART_CONTEXT)).toHaveLength(2);
    expect(fifoMessages.indexOf(HOST_RESTART_CONTEXT)).toBeLessThan(
      fifoMessages.indexOf("FIFO_HUMAN_TASK"),
    );
    expect(result.fifoResults).toMatchObject([
      { subtype: "success", num_turns: 0, user_message_uuids: [result.fifoBootUuid] },
      {
        subtype: "success",
        num_turns: 1,
        user_message_uuids: [result.humanUuid],
        queued_turn_count: 0,
      },
    ]);
  },
  30_000,
);

import { expect, it } from "vitest";
import { probeSteering } from "../../../../scripts/claude-sdk-contract/steering.mjs";

const nativeIt = it.skipIf(process.platform !== "linux" || process.arch !== "x64");

nativeIt(
  "pinned native now input reaches Claude while its MCP tool remains blocked",
  async () => {
    const result = await probeSteering("tool");
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
